import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Store } from "../server/store";
import { parseStructured } from "../server/providers/structured";
import {
  overpass,
  overpassQuery,
  normalizeOSM,
} from "../server/providers/overpass";
import { getProvider } from "../server/providers/registry";
import { canonicalUrl } from "../server/normalize";
import { entitySchema } from "../shared/model";
import { inPeriod } from "../shared/dates";
import { SyncService } from "../server/sync";
import { isPrivateAddress } from "../server/providers/http";
let store: Store;
beforeEach(() => (store = new Store(":memory:")));
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});
const context = () => ({
  source: {
    ...store.source("source-structured"),
    url: "https://venue.test/events",
    enabled: true,
  },
  scope: store.scope("belgrade"),
  secrets: {},
});
describe("providers", () => {
  it("does not treat a configured secret as a working skeleton", () => {
    const ctx = context();
    ctx.source.providerId = "telegram";
    const state = getProvider("telegram").connectionStatus({
      ...ctx,
      secrets: { TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "key" },
    });
    expect(state.status).toBe("setup_required");
    expect(state.canSync).toBe(false);
  });
  it("missing credentials disable Ticketmaster without failing app", () => {
    const ctx = context();
    expect(getProvider("ticketmaster").connectionStatus(ctx).status).toBe(
      "not_configured",
    );
  });
  it("normalizes OSM POIs and builds correct area query", () => {
    const ctx = context();
    expect(overpassQuery(ctx)).toContain("area(3602728438)");
    const value = normalizeOSM(
      {
        externalId: "node/1",
        url: "https://www.openstreetmap.org/node/1",
        rawText: "",
        payload: {
          id: 1,
          type: "node",
          lat: 44.81,
          lon: 20.46,
          tags: {
            name: "Скалодром",
            sport: "climbing",
            website: "example.test",
            "addr:city": "Београд",
          },
        },
      },
      ctx,
    )!;
    expect(value.category).toBe("Спорт");
    expect(value.knownIds.osm).toBe("node/1");
    expect(value.website).toBe("https://example.test");
    expect(entitySchema.safeParse(value).success).toBe(true);
  });
  it("extracts nested schema.org events and retains original payload", () => {
    const ctx = context();
    const body =
      '<script type="application/ld+json">' +
      JSON.stringify({
        "@graph": [
          {
            "@type": "MusicEvent",
            name: "Jazz",
            startDate: "2026-10-02T20:00:00+02:00",
            url: "/event/1",
            location: { name: "Club", address: { streetAddress: "Street 1" } },
          },
        ],
      }) +
      "</script>";
    const result = parseStructured(body, ctx);
    expect(result.items).toHaveLength(1);
    expect((result.items[0].payload as any).normalized.url).toBe(
      "https://venue.test/event/1",
    );
    expect((result.items[0].payload as any).original.name).toBe("Jazz");
  });
  it("does not use publication date as the event date", () => {
    const result = parseStructured(
      "<rss><channel><item><title>Show</title><guid>1</guid><link>https://v.test/e</link><pubDate>Wed, 1 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>",
      context(),
    );
    expect((result.items[0].payload as any).normalized.startAt).toBe("");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it("parses ICS TZID and skips recurring events with a warning", () => {
    const ics =
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART;TZID=Europe/Belgrade:20261002T200000\r\nSUMMARY:Jazz\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nDTSTART:20261003T180000Z\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Weekly\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const r = parseStructured(ics, context());
    expect(r.items).toHaveLength(1);
    expect((r.items[0].payload as any).normalized.startAt).toBe(
      "2026-10-02T18:00:00.000Z",
    );
    expect(r.warnings).toHaveLength(1);
  });
  it("refuses unsupported HTML rather than pretending sync succeeded", () =>
    expect(() =>
      parseStructured("<html><p>No structured data</p></html>", context()),
    ).toThrow("не найдены"));
  it("keeps date-only data and rejects dates without timezone", () => {
    expect(
      entitySchema.safeParse({
        type: "Event",
        title: "A",
        startAt: "2026-10-01T20:00",
      }).success,
    ).toBe(false);
    expect(
      entitySchema.safeParse({
        type: "Event",
        title: "A",
        startAt: "2026-10-01",
      }).success,
    ).toBe(true);
  });
  it("strips only tracking query parameters", () => {
    expect(
      canonicalUrl("https://www.site.test/event?id=1&utm_source=tg#x"),
    ).toBe("https://site.test/event?id=1");
  });
  it("filters event days in Belgrade, not UTC", () => {
    expect(
      inPeriod("2026-10-01T23:30:00Z", "today", "", "", "2026-10-02"),
    ).toBe(true);
    expect(inPeriod("2026-10-03", "weekend", "", "", "2026-10-02")).toBe(true);
    expect(inPeriod("2026-10-05", "week", "", "", "2026-10-02")).toBe(false);
  });
  it("rejects local and mapped private IPs", () => {
    for (const ip of [
      "127.0.0.1",
      "192.168.1.1",
      "10.2.3.4",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
  });
  it("records a sync and persists cooldown", async () => {
    vi.spyOn(overpass, "sync").mockResolvedValue({
      items: [
        {
          externalId: "node/1",
          url: "https://www.openstreetmap.org/node/1",
          rawText: "",
          payload: {
            id: 1,
            type: "node",
            tags: { name: "Gym", sport: "climbing" },
          },
        },
      ],
    });
    const sync = new SyncService(store);
    const r = await sync.run("source-overpass");
    expect(r).toMatchObject({ fetched: 1, created: 1, errors: 0 });
    expect(sync.runs()[0].status).toBe("success");
    await expect(new SyncService(store).run("source-overpass")).rejects.toThrow(
      "сек.",
    );
  });
  it("persists provider failures with no fabricated records", async () => {
    vi.spyOn(overpass, "sync").mockRejectedValue(new Error("HTTP 429"));
    const sync = new SyncService(store);
    await expect(sync.run("source-overpass")).rejects.toThrow("HTTP 429");
    expect(store.entities()).toHaveLength(0);
    expect(sync.runs()[0].status).toBe("error");
    expect(store.source("source-overpass").lastError).toBe("HTTP 429");
  });
});
it("refreshes credential presence without leaking its value", () => {
  const source = store.source("source-ticketmaster");
  store.saveSource(
    { providerId: source.providerId, name: source.name, enabled: true },
    source.id,
  );
  vi.stubEnv("TICKETMASTER_API_KEY", "test-credential-not-for-network");
  const view = new SyncService(store).views().find((s) => s.id === source.id)!;
  expect(view.connection.canSync).toBe(true);
  expect(JSON.stringify(view)).not.toContain("test-credential-not-for-network");
  vi.unstubAllEnvs();
});
it("rejects imaginary dates", () =>
  expect(
    entitySchema.safeParse({ type: "Event", title: "A", startAt: "2026-02-30" })
      .success,
  ).toBe(false));

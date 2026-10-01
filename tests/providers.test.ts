import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Store } from "../server/store";
import { parseStructured } from "../server/providers/structured";
import {
  overpass,
  overpassQuery,
  normalizeOSM,
} from "../server/providers/overpass";
import { getProvider, providers } from "../server/providers/registry";
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
function enableOverpass() {
  const source = store.source("source-overpass");
  store.saveSource(
    { providerId: source.providerId, name: source.name, enabled: true },
    source.id,
  );
}
describe("providers", () => {
  it("exposes the implemented Telegram tool when credentials are configured", () => {
    const ctx = context();
    ctx.source.providerId = "telegram";
    const provider = getProvider("telegram");
    const state = provider.connectionStatus({
      ...ctx,
      secrets: { TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "key" },
    });
    expect(provider.modelCallable).toBe(true);
    expect(provider.mcpTools?.map((tool) => tool.name)).toEqual([
      "telegram_status",
      "telegram_discovery_batch",
      "telegram_search_public_chats",
      "telegram_search_posts",
      "telegram_search_global",
      "telegram_channel_recommendations",
      "telegram_sample_channel_posts",
      "telegram_query_history",
      "telegram_mark_query_relevance",
    ]);
    expect(state.status).toBe("ready");
    expect(state.canSync).toBe(true);
  });
  it("exposes every implemented Apify search through MCP", () => {
    for (const id of ["instagram", "facebook-apify", "google-places"]) {
      const provider = getProvider(id);
      expect(provider.modelCallable).toBe(true);
      expect(provider.mcpServer).toBe("Activity Checker Apify");
      expect(provider.mcpTools?.[0].name).toBe("apify_status");
    }
    expect(getProvider("facebook-apify").mcpTools?.[1].name).toBe(
      "apify_facebook_events_search",
    );
  });
  it("keeps Apify Google Maps and exposes official Google Places separately", () => {
    expect(getProvider("google-places")).toMatchObject({
      name: "Google Maps Places · Apify",
      mcpServer: "Activity Checker Apify",
    });
    expect(getProvider("google-places-api")).toMatchObject({
      name: "Google Places API (New)",
      mcpServer: "Activity Checker Google Places",
      configFields: ["scope", "keyword", "minRating"],
    });
    expect(
      getProvider("google-places-api").mcpTools?.map((tool) => tool.name),
    ).toEqual([
      "google_places_status",
      "google_places_discovery_batch",
      "google_places_text_search_ids",
      "google_places_text_search_pro",
      "google_places_text_search_enterprise",
      "google_places_store_llm_ratings",
    ]);
  });
  it("classifies sources by use and hides deprecated PredictHQ", () => {
    expect(getProvider("tickets").group).toBe("API Агрегаторы");
    expect(getProvider("telegram").group).toBe("MCP");
    expect(getProvider("meetup")).toMatchObject({
      group: "LLM Web",
      webSearchLlm: true,
      credentials: [],
    });
    expect(getProvider("eventbrite")).toMatchObject({
      group: "LLM Web",
      webSearchLlm: true,
      credentials: [],
    });
    expect(getProvider("belgrade-beat")).toMatchObject({
      group: "API Агрегаторы",
      implemented: true,
      configFields: [],
    });
    expect(getProvider("belgrade-beat-web")).toMatchObject({
      group: "LLM Web",
      webSearchLlm: true,
      credentials: [],
    });
    expect(getProvider("predicthq").hiddenFromSources).toBe(true);
    expect(getProvider("facebook-scrapecreators")).toMatchObject({
      hiddenFromSources: true,
      credentials: [],
    });
    expect(getProvider("ticketmaster").otherSource).toBe(true);
  });
  it("declares only the source settings consumed by each adapter", () => {
    expect(
      Object.fromEntries(
        providers.map((provider) => [provider.id, provider.configFields]),
      ),
    ).toEqual({
      overpass: ["scope"],
      ticketmaster: ["scope", "keyword"],
      structured: ["scope", "url", "format"],
      manual: [],
      "belgrade-beat": [],
      afisha: ["url"],
      bilet: ["scope", "url", "keyword"],
      tickets: ["url", "keyword"],
      "serbia-travel": ["scope", "url", "keyword"],
      allevents: ["url", "keyword"],
      telegram: ["url", "keyword"],
      foursquare: ["scope", "keyword"],
      "google-places-api": ["scope", "keyword", "minRating"],
      instagram: ["keyword"],
      "facebook-apify": ["keyword"],
      "google-places": ["keyword"],
      "facebook-scrapecreators": [],
      meetup: [],
      eventbrite: [],
      "belgrade-beat-web": [],
      predicthq: [],
    });
  });
  it("allows direct sync of legacy disabled sources without an enable toggle", () => {
    const source = store.source("source-overpass");
    expect(source.enabled).toBe(false);
    const state = overpass.connectionStatus({
      source,
      scope: store.scope("belgrade"),
      secrets: {},
    });
    expect(state.status).toBe("ready");
    expect(state.canSync).toBe(true);
  });
  it("runs ordinary API aggregators globally without using the legacy enabled flag", async () => {
    const selected = ["afisha", "belgrade-beat", "bilet", "tickets"];
    const syncMocks = selected.map((id) =>
      vi.spyOn(getProvider(id), "sync").mockResolvedValue({ items: [] }),
    );
    const excludedMocks = ["overpass", "telegram"].map((id) =>
      vi.spyOn(getProvider(id), "sync").mockResolvedValue({ items: [] }),
    );
    const result = await new SyncService(store).all("belgrade");
    expect(result.map((item) => item.sourceId).sort()).toEqual(
      selected.map((id) => `source-${id}`).sort(),
    );
    syncMocks.forEach((mock) => expect(mock).toHaveBeenCalledOnce());
    excludedMocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
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
    enableOverpass();
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
  it("drops past events returned by a local listing before ingestion", async () => {
    const source = store.source("source-afisha");
    store.saveSource(
      {
        providerId: source.providerId,
        name: source.name,
        url: source.url,
        scopeId: source.scopeId,
        enabled: true,
      },
      source.id,
    );
    const provider = getProvider("afisha");
    vi.spyOn(provider, "sync").mockResolvedValue({
      items: [
        {
          externalId: "past",
          url: "https://afisha.rs/past",
          rawText: "Past",
          payload: {
            normalized: {
              type: "Event",
              title: "Past event",
              startAt: "2000-01-01",
            },
          },
        },
        {
          externalId: "future",
          url: "https://afisha.rs/future",
          rawText: "Future",
          payload: {
            normalized: {
              type: "Event",
              title: "Future event",
              startAt: "2099-01-01",
            },
          },
        },
      ],
    });
    const result = await new SyncService(store).run(source.id);
    expect(result).toMatchObject({ fetched: 2, created: 2, filtered: 1 });
    expect(store.entities().map((entity) => entity.title)).toEqual([
      "Future event",
    ]);
    expect("warnings" in result ? result.warnings : []).toContain(
      "Скрыто статичными правилами фильтрации: 1.",
    );
  });
  it("persists provider failures with no fabricated records", async () => {
    enableOverpass();
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

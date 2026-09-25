import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { providers, getProvider } from "../server/providers/registry";
import bilet, { parseBiletPage } from "../server/providers/websites/bilet";
import serbia, {
  parseSerbiaCalendar,
} from "../server/providers/websites/serbia-travel";
import { requestOverpass } from "../server/providers/overpass";
import { fetchText, fetchJson } from "../server/providers/http";
import type { ProviderContext } from "../server/providers/types";
vi.mock("../server/providers/http", () => ({
  fetchText: vi.fn(),
  fetchJson: vi.fn(),
}));
let store: Store, ctx: ProviderContext;
beforeEach(() => {
  vi.resetAllMocks();
  store = new Store(":memory:");
  ctx = {
    source: { ...store.source("source-bilet"), enabled: true },
    scope: store.scope("belgrade"),
    secrets: {},
  };
});
afterEach(() => store.close());
function biletPage(
  id = 1,
  venue = "Club, Beograd",
  next = "",
  location = "Beograd",
) {
  const url = `https://app.bilet.rs/events/${id}/show`;
  const json = {
    "@type": "ItemList",
    itemListElement: [
      {
        "@type": "ListItem",
        item: {
          "@type": "Event",
          name: `Show ${id}`,
          url,
          startDate: "2026-10-10T20:00:00+02:00",
        },
      },
    ],
  };
  return `<input name="location" value="${location}"><script type="application/ld+json">${JSON.stringify(json)}</script><article class="card"><a class="card-link" href="/events/${id}/show"><div class="meta-row"><span class="meta-item">10.10.2026 20:00</span></div><div class="meta-row"><span class="meta-item">${venue}</span></div></a></article>${next ? `<a aria-label="Sledeća strana" href="${next}"></a>` : ""}`;
}
function calendar(
  city = "Belgrade",
  date = "02.10.2026 - 05.10.2026",
  id = "1",
) {
  return `<div class="event-item"><a class="event-link" href="https://www.serbia.travel/en/events/event-${id}/"><div data-id="${id}"><p class="city">${city}</p></div><h2>Festival</h2><p class="date-from-to">${date}</p><p class="categories">Music festivals</p></a></div>`;
}
describe("public providers audit regressions", () => {
  it("marks all credential-based providers with the correct registration service", () => {
    expect(providers.filter((p) => p.registration)).toHaveLength(11);
    for (const p of providers)
      expect(!!p.registration).toBe(p.credentials.length > 0);
    expect(getProvider("instagram").registration?.service).toBe("Apify");
    expect(getProvider("facebook-scrapecreators").registration?.service).toBe(
      "ScrapeCreators",
    );
    const planned = getProvider("belgrade-beat");
    expect(planned.connectionStatus(ctx).canSync).toBe(false);
    expect(planned.connectionStatus(ctx).message).toContain("HTTP 403");
  });
  it("extracts Bilet venues and preserves the original event identity", () => {
    const r = parseBiletPage(
      biletPage(),
      "https://bilet.rs/events?location=Beograd",
      ctx,
    );
    expect(r.items).toHaveLength(1);
    expect(bilet.normalize(r.items[0], ctx)).toMatchObject({
      city: "Belgrade",
      venue: "Club, Beograd",
      startAt: "2026-10-10T20:00:00+02:00",
    });
    expect((r.items[0].payload as any).original.name).toBe("Show 1");
  });
  it("does not label Leskovac as Belgrade and leaves unknown country-wide cities empty", () => {
    expect(
      parseBiletPage(
        biletPage(1, "Hala Partizan, Leskovac"),
        "https://bilet.rs/events",
        ctx,
      ).items,
    ).toHaveLength(0);
    ctx.scope = store.scope("serbia");
    let r = parseBiletPage(
      biletPage(1, "Hala Partizan, Leskovac", "", ""),
      "https://bilet.rs/events",
      ctx,
    );
    expect(bilet.normalize(r.items[0], ctx)?.city).toBe("Leskovac");
    r = parseBiletPage(
      biletPage(1, "Club without city", "", ""),
      "https://bilet.rs/events",
      ctx,
    );
    expect(bilet.normalize(r.items[0], ctx)?.city).toBe("");
  });
  it("rejects unconfirmed city filters, foreign next links and app shells", () => {
    expect(() =>
      parseBiletPage(
        biletPage(1, "Club", "", ""),
        "https://bilet.rs/events",
        ctx,
      ),
    ).toThrow("фильтр");
    expect(() =>
      parseBiletPage(
        biletPage(1, "Club", "https://foreign.test/events?page=1"),
        "https://bilet.rs/events",
        ctx,
      ),
    ).toThrow("следующей");
    expect(() =>
      parseBiletPage(
        "<html>Enable JavaScript</html>",
        "https://bilet.rs/events",
        ctx,
      ),
    ).toThrow("список");
  });
  it("paginates Bilet while retaining city and country filters", async () => {
    vi.mocked(fetchText)
      .mockResolvedValueOnce(biletPage(1, "Club, Beograd", "/events?page=1"))
      .mockResolvedValueOnce(biletPage(2));
    const r = await bilet.sync(ctx);
    expect(r.items).toHaveLength(2);
    const next = new URL(vi.mocked(fetchText).mock.calls[1][0]);
    expect(next.hostname).toBe("bilet.rs");
    expect(next.searchParams.get("location")).toBe("Beograd");
    expect(next.searchParams.get("countryCode")).toBe("RS");
  });
  it("rejects duplicate Bilet pages and permits explicit empty search results", async () => {
    vi.mocked(fetchText).mockResolvedValue(
      biletPage(1, "Club", "/events?page=1"),
    );
    await expect(bilet.sync(ctx)).rejects.toThrow("повторяет");
    const r = parseBiletPage(
      '<input name="location" value="Beograd"><script type="application/ld+json">{"@type":"ItemList","itemListElement":[]}</script>',
      "https://bilet.rs/events",
      ctx,
    );
    expect(r.items).toHaveLength(0);
  });
  it("parses Serbia Calendar dates and real city, filtering only when a city was requested", () => {
    const body = {
      html: calendar("Novi Sad") + calendar("Belgrade", "02.10.2026", "2"),
      hasMore: false,
    };
    expect(parseSerbiaCalendar(body, ctx).items).toHaveLength(1);
    ctx.scope = store.scope("serbia");
    const r = parseSerbiaCalendar(body, ctx);
    expect(r.items).toHaveLength(2);
    expect(serbia.normalize(r.items[0], ctx)).toMatchObject({
      city: "Novi Sad",
      startAt: "2026-10-02",
      endAt: "2026-10-05",
      category: "Музыка",
    });
  });
  it("rejects changed calendar shape, invalid dates and incomplete pagination", () => {
    expect(() => parseSerbiaCalendar({ data: [] }, ctx)).toThrow("формат");
    expect(() =>
      parseSerbiaCalendar(
        { html: calendar("Belgrade", "31.02.2026"), hasMore: false },
        ctx,
      ),
    ).toThrow();
    expect(() => parseSerbiaCalendar({ html: "", hasMore: true }, ctx)).toThrow(
      "промежуточную",
    );
    expect(
      parseSerbiaCalendar({ html: "", hasMore: false }, ctx).items,
    ).toEqual([]);
    expect(
      parseSerbiaCalendar(
        { html: "<p>No events found.</p>", hasMore: false },
        ctx,
      ).items,
    ).toEqual([]);
    expect(() =>
      parseSerbiaCalendar(
        { html: "<p>Access denied.</p>", hasMore: false },
        ctx,
      ),
    ).toThrow("карточки");
  });
  it("uses the Overpass backup only after transient failure and reports it", async () => {
    vi.mocked(fetchJson)
      .mockRejectedValueOnce(new Error("Источник ответил HTTP 504"))
      .mockResolvedValueOnce({ elements: [] });
    const result = await requestOverpass(ctx);
    expect(result.warnings).toHaveLength(1);
    expect(vi.mocked(fetchJson).mock.calls[1][0]).toBe(
      "https://overpass.private.coffee/api/interpreter",
    );
  });
  it("does not retry rate limits, override a custom endpoint or accept partial results", async () => {
    vi.mocked(fetchJson).mockRejectedValue(
      new Error("Источник ответил HTTP 429"),
    );
    await expect(requestOverpass(ctx)).rejects.toThrow("429");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    vi.mocked(fetchJson).mockClear();
    ctx.secrets = { OVERPASS_URL: "https://custom.test/interpreter" };
    vi.mocked(fetchJson).mockRejectedValue(new Error("HTTP 504"));
    await expect(requestOverpass(ctx)).rejects.toThrow("504");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    vi.mocked(fetchJson).mockResolvedValue({
      elements: [{ id: 1 }],
      remark: "Runtime memory limit",
    });
    await expect(requestOverpass(ctx)).rejects.toThrow("неполный");
  });
});

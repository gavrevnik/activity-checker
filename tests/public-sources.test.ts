import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { providers, getProvider } from "../server/providers/registry";
import serbia, {
  parseSerbiaCalendar,
} from "../server/providers/websites/serbia-travel";
import belgradeBeat, {
  belgradeBeatDay,
  dedupeBelgradeBeatItems,
  parseBelgradeBeatPage,
} from "../server/providers/websites/belgrade-beat";
import afisha, { parseAfishaPage } from "../server/providers/websites/afisha";
import { fetchText, fetchJson } from "../server/providers/http";
import type { ProviderContext } from "../server/providers/types";
vi.mock("@personal-radar/connectors/http", () => ({
  fetchText: vi.fn(),
  fetchJson: vi.fn(),
}));
let store: Store, ctx: ProviderContext;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request in offline provider test");
    }),
  );
  vi.resetAllMocks();
  store = new Store(":memory:");
  ctx = {
    source: { ...store.source("source-serbia-travel"), enabled: true },
    scope: store.scope("belgrade"),
    secrets: {},
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
});
function calendar(
  city = "Belgrade",
  date = "02.10.2026 - 05.10.2026",
  id = "1",
) {
  return `<div class="event-item"><a class="event-link" href="https://www.serbia.travel/en/events/event-${id}/"><div data-id="${id}"><p class="city">${city}</p></div><h2>Festival</h2><p class="date-from-to">${date}</p><p class="categories">Music festivals</p></a></div>`;
}
function beatPage(
  sections: {
    heading: string;
    slug: string;
    title?: string;
    time?: string;
  }[],
) {
  return sections
    .map(
      ({ heading, slug, title = "Jazz Night", time = "18:00" }) => `
        <h2 class="mt0 pt4 f2x ttu">${heading}</h2>
        <div class="js-event js-event-music">
          <div class="db dn-ns rowx"><h2>Mobile duplicate</h2></div>
          <div class="dn db-ns rowx">
            <div class="colx w-25">
              <a href="/events/${slug}"><img src="/photos/${slug}.jpg"></a>
            </div>
            <div class="colx w-75">
              <div><a href="/events/${slug}"><h2>${title}</h2></a></div>
              <div class="mt2 tj">Live music in Belgrade.</div>
              <div class="mt2"><span>From:</span> ${time}</div>
              <div class="mt2"><span>Where:</span> <a href="/venues/test-club">Test Club</a></div>
              <div class="mt1"><div class="gold">Music</div></div>
            </div>
          </div>
        </div>`,
    )
    .join("");
}
function afishaEvent(id: number, title = `Event ${id}`) {
  return {
    id,
    title,
    description: "<p>Full <strong>description</strong></p>",
    url: `/ru/koncerty/event-${id}`,
    image_styles: { original: `https://afisha.rs/images/${id}.webp` },
    date: "2026-10-02",
    date2: "2026-10-03",
    time: "20:00",
    price: "1500",
    section: { title: "Концерты", slug: "/ru/koncerty" },
    venue: { title: "Test Club", slug: "/ru/venues/test-club" },
    ticket_link: `https://tickets.test/event-${id}`,
  };
}
function afishaPage(items: unknown[], pageCount = 1, itemCount = items.length) {
  return {
    page_count: pageCount,
    item_count: itemCount,
    items,
  };
}
describe("public providers audit regressions", () => {
  it("marks all credential-based providers with the correct registration service", () => {
    expect(providers.filter((p) => p.registration)).toHaveLength(8);
    for (const p of providers)
      expect(!!p.registration).toBe(p.credentials.length > 0);
    expect(getProvider("instagram").registration?.service).toBe("Apify");
    expect(getProvider("facebook-scrapecreators").hiddenFromSources).toBe(true);
    const aggregator = getProvider("belgrade-beat");
    expect(aggregator).toMatchObject({
      group: "API Агрегаторы",
      implemented: true,
      configFields: [],
    });
    expect(aggregator.otherSource).toBeUndefined();
    expect(
      aggregator.connectionStatus({
        ...ctx,
        source: store.source("source-belgrade-beat"),
      }).canSync,
    ).toBe(true);
    expect(getProvider("belgrade-beat-web")).toMatchObject({
      group: "LLM Web",
      webSearchLlm: true,
    });
    expect(getProvider("ticketmaster").otherSource).toBe(true);
  });
  it("parses Belgrade Beat dates and only reads the desktop event card", () => {
    const parsed = parseBelgradeBeatPage(
      beatPage([
        { heading: "TODAY'S EVENTS", slug: "jazz-night" },
        {
          heading: "FRIDAY, OCTOBER 2nd EVENTS",
          slug: "tomorrow-show",
          title: "Tomorrow Show",
          time: "All day",
        },
      ]),
      "https://belgrade-beat.com/events/this-week",
      ctx,
      "2026-10-01",
    );
    expect(parsed.items).toHaveLength(2);
    expect(belgradeBeat.normalize(parsed.items[0], ctx)).toMatchObject({
      type: "Event",
      title: "Jazz Night",
      category: "Музыка",
      startAt: "2026-10-01T16:00:00.000Z",
      venue: "Test Club",
      url: "https://belgrade-beat.com/events/jazz-night",
      imageUrl: "https://belgrade-beat.com/photos/jazz-night.jpg",
    });
    expect(belgradeBeat.normalize(parsed.items[1], ctx)?.startAt).toBe(
      "2026-10-02",
    );
    expect(belgradeBeatDay("MONDAY, JANUARY 4th EVENTS", "2026-12-30")).toBe(
      "2027-01-04",
    );
  });
  it("deduplicates Belgrade Beat URLs before ingestion and keeps the earliest date", async () => {
    ctx.source = store.source("source-belgrade-beat");
    vi.mocked(fetchText)
      .mockResolvedValueOnce(
        beatPage([
          {
            heading: "SATURDAY, OCTOBER 3rd EVENTS",
            slug: "repeated-show",
          },
          {
            heading: "SATURDAY, OCTOBER 3rd EVENTS",
            slug: "unique-show",
            title: "Unique Show",
          },
        ]),
      )
      .mockResolvedValueOnce(
        beatPage([
          {
            heading: "FRIDAY, OCTOBER 2nd EVENTS",
            slug: "repeated-show",
          },
        ]),
      );

    const synced = await belgradeBeat.sync(ctx);
    expect(fetchText).toHaveBeenNthCalledWith(
      1,
      "https://belgrade-beat.com/events/this-week",
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      2,
      "https://belgrade-beat.com/events/next-week",
    );
    expect(synced.items).toHaveLength(2);
    expect(
      belgradeBeat.normalize(
        synced.items.find((item) => item.externalId === "repeated-show")!,
        ctx,
      )?.startAt,
    ).toBe("2026-10-02T16:00:00.000Z");
    expect(synced.warnings).toContain(
      "Belgrade Beat: до записи схлопнуто повторов по event URL: 1; оставлена самая ранняя дата.",
    );

    const records = synced.items.map((raw) => ({
      raw,
      entity: belgradeBeat.normalize(raw, ctx)!,
    }));
    expect(store.ingest(ctx.source, records)).toMatchObject({
      created: 2,
      duplicates: 0,
    });
    expect(store.ingest(ctx.source, records)).toMatchObject({
      created: 0,
      duplicates: 2,
    });
    expect(store.entities({ includeFiltered: true })).toHaveLength(2);
  });
  it("chooses the earliest Belgrade Beat occurrence for the same canonical URL", () => {
    const later = parseBelgradeBeatPage(
      beatPage([
        {
          heading: "SATURDAY, OCTOBER 3rd EVENTS",
          slug: "multi-day",
        },
      ]),
      "https://belgrade-beat.com/events/this-week",
      ctx,
      "2026-10-01",
    ).items[0];
    const earlier = parseBelgradeBeatPage(
      beatPage([
        {
          heading: "FRIDAY, OCTOBER 2nd EVENTS",
          slug: "multi-day",
        },
      ]),
      "https://belgrade-beat.com/events/next-week",
      ctx,
      "2026-10-01",
    ).items[0];
    const result = dedupeBelgradeBeatItems([later, earlier]);
    expect(result).toMatchObject({ duplicates: 1 });
    expect(belgradeBeat.normalize(result.items[0], ctx)?.startAt).toBe(
      "2026-10-02T16:00:00.000Z",
    );
  });
  it("parses Afisha.rs API cards with section, venue and full text", () => {
    ctx.source = store.source("source-afisha");
    const result = parseAfishaPage(afishaPage([afishaEvent(42)]), ctx);
    expect(result).toMatchObject({ pageCount: 1, itemCount: 1, rawCount: 1 });
    expect(result.warnings).toEqual([]);
    expect(afisha.normalize(result.items[0], ctx)).toMatchObject({
      type: "Event",
      title: "Event 42",
      description: "Full description",
      category: "Музыка",
      rawCategory: "Концерты",
      tags: ["Концерты"],
      startAt: "2026-10-02T18:00:00.000Z",
      endAt: "2026-10-03",
      venue: "Test Club",
      price: "1500 RSD",
      url: "https://afisha.rs/ru/koncerty/event-42",
      website: "https://tickets.test/event-42",
      imageUrl: "https://afisha.rs/images/42.webp",
      externalId: "42",
      knownIds: { afisha_rs: "42" },
    });
    const dateOnly = parseAfishaPage(
      afishaPage([
        {
          ...afishaEvent(43),
          date2: "2026-10-02",
          time: "00:00:00",
        },
      ]),
      ctx,
    );
    expect(afisha.normalize(dateOnly.items[0], ctx)?.startAt).toBe(
      "2026-10-02",
    );
  });
  it("keeps Afisha.rs inside /ru and excludes the children and cinema sections", () => {
    ctx.source = store.source("source-afisha");
    const result = parseAfishaPage(
      afishaPage([
        {
          ...afishaEvent(44),
          url: "/ru/deti/children-event",
          section: { title: "Дети", slug: "/ru/deti" },
        },
        {
          ...afishaEvent(45),
          url: "/ru/kino/movie-event",
          section: { title: "Кино", slug: "/ru/kino" },
        },
        {
          ...afishaEvent(46),
          url: "/sr/koncerti/serbian-event",
          section: { title: "Koncerti", slug: "/sr/koncerti" },
        },
      ]),
      ctx,
    );
    expect(result.items).toEqual([]);
    expect(result.excludedCount).toBe(2);
    expect(result.warnings).toEqual([
      "Afisha.rs: карточка 46 вне русскоязычного раздела /ru пропущена.",
    ]);
  });
  it("loads every Afisha.rs page and deduplicates repeated event IDs", async () => {
    ctx.source = store.source("source-afisha");
    vi.mocked(fetchJson)
      .mockResolvedValueOnce(afishaPage([afishaEvent(1), afishaEvent(2)], 2, 4))
      .mockResolvedValueOnce(
        afishaPage([afishaEvent(2), afishaEvent(3)], 2, 4),
      );

    const result = await afisha.sync(ctx);

    expect(fetchJson).toHaveBeenNthCalledWith(
      1,
      "https://afisha.rs/ru/api/term-content/0/all/0",
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      2,
      "https://afisha.rs/ru/api/term-content/0/all/1",
    );
    expect(result.items.map((item) => item.externalId)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(result.warnings).toContain(
      "Afisha.rs: до записи схлопнуто повторов по ID: 1.",
    );
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
});

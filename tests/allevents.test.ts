import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import allEvents, {
  ALLEVENTS_ROWS,
  clearAllEventsPreviewsForTests,
  parseAllEventsEvent,
} from "../server/providers/websites/allevents";
import { SyncService } from "../server/sync";
import { localDay } from "../shared/dates";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]),
}));

let store: Store;
beforeEach(() => {
  clearAllEventsPreviewsForTests();
  store = new Store(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

function context() {
  return {
    source: store.source("source-allevents"),
    scope: store.scope("belgrade"),
    secrets: {},
  };
}
function event(id = "event-1") {
  return {
    event_id: id,
    eventname: "Belgrade Jazz Night",
    start_time: 1790971200,
    end_time: 1790978400,
    location: "Jazz Club",
    venue: {
      street: "Cetinjska 15",
      city: "Belgrade",
      latitude: "44.817",
      longitude: "20.463",
    },
    event_url: `https://allevents.in/belgrade/${id}`,
    categories: ["music", "concerts"],
    organizer: { name: "Local promoter" },
    short_description: "An evening concert",
  };
}
function bootstrap(
  events: unknown[] = [],
  startDate?: string,
  endDate?: string,
) {
  const range =
    startDate && endDate
      ? `_this.search_sdate = ${Date.parse(`${startDate}T00:00:00Z`) / 1000};_this.search_edate = ${Date.parse(`${endDate}T00:00:00Z`) / 1000};`
      : "";
  return new Response(
    `<html><script>window.__cst = "abcdefghijklmnopqrstuvwx";_this.events_data = ${JSON.stringify(events)};${range}</script></html>`,
    { status: 200, headers: { "set-cookie": "session=abc; Path=/" } },
  );
}
function day(offset = 0) {
  const current = new Date(`${localDay()}T12:00:00Z`);
  current.setUTCDate(current.getUTCDate() + offset);
  return current.toISOString().slice(0, 10);
}

describe("AllEvents adapter", () => {
  it("normalizes a card and retains the original raw payload", () => {
    const raw = parseAllEventsEvent(event(), context());
    expect((raw.payload as any).normalized).toMatchObject({
      type: "Event",
      title: "Belgrade Jazz Night",
      category: "Музыка",
      address: "Cetinjska 15",
    });
    expect((raw.payload as any).original.organizer.name).toBe("Local promoter");
  });

  it("uses rows=50 and the selected dates/categories", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: [event()], count: 1 }), {
          status: 200,
        }),
      );
    const requested = {
      confirmed: false,
      startDate: day(),
      endDate: day(30),
      categories: ["music", "concerts"],
    };
    const plan = await allEvents.planSync!(context(), requested);
    const result = await allEvents.sync(context(), {
      ...requested,
      confirmed: true,
      previewId: plan.previewId,
    });
    expect(result.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toMatchObject({
      rows: ALLEVENTS_ROWS,
      page: 1,
      category: ["music", "concerts"],
    });
  });

  it("stops after three consecutive blocking responses", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 403 }));
    const sync = new SyncService(store);
    await expect(
      sync.plan("source-allevents", {
        confirmed: false,
        startDate: day(),
        endDate: day(30),
        categories: ["all"],
      }),
    ).rejects.toThrow("трёх ответов блокировки");
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(store.source("source-allevents").lastError).toContain(
      "трёх ответов блокировки",
    );
  });

  it("reuses the visible HTML page and syncs it without another request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bootstrap([event("visible-1")], day(), day(30)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: [], count: 0 }), { status: 200 }),
      );
    const plan = await allEvents.planSync!(context(), { confirmed: false });
    expect(plan).toMatchObject({
      exactPages: 1,
      previewRequests: 2,
      requestsAfterConfirmation: 0,
      firstPageReused: true,
    });
    const result = await allEvents.sync(context(), {
      confirmed: true,
      startDate: plan.startDate,
      endDate: plan.endDate,
      categories: plan.categories,
      previewId: plan.previewId,
    });
    expect(result.items.map((item) => item.externalId)).toEqual(["visible-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces duplicate preview calls into one remote traversal", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bootstrap([event("visible-1")], day(), day(30)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: [], count: 0 }), { status: 200 }),
      );
    const [first, second] = await Promise.all([
      allEvents.planSync!(context(), { confirmed: false }),
      allEvents.planSync!(context(), { confirmed: false }),
    ]);
    expect(first.previewId).toBe(second.previewId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === "https://allevents.in/belgrade/all",
      ),
    ).toHaveLength(1);
  });

  it("deduplicates an event repeated by HTML and pagination", async () => {
    const firstPage = Array.from({ length: 15 }, (_, index) =>
      event(`page-1-${index}`),
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(bootstrap(firstPage, day(), day(30)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            item: [firstPage[0], event("page-2-new")],
            count: 2,
          }),
          { status: 200 },
        ),
      );
    const plan = await allEvents.planSync!(context(), { confirmed: false });
    const result = await allEvents.sync(context(), {
      confirmed: true,
      startDate: plan.startDate,
      endDate: plan.endDate,
      categories: plan.categories,
      previewId: plan.previewId,
    });
    expect(plan.exactPages).toBe(2);
    expect(result.items).toHaveLength(16);
    expect(result.warnings?.join(" ")).toContain("Убраны повторы");
  });

  it("persists a stopped run so the UI can show a notification", async () => {
    vi.spyOn(allEvents, "sync").mockRejectedValue(
      new Error(
        "AllEvents остановлен после трёх ответов блокировки (403, 429, 403).",
      ),
    );
    const sync = new SyncService(store);
    await expect(
      sync.run("source-allevents", false, { confirmed: true }),
    ).rejects.toThrow("трёх ответов блокировки");
    expect(store.source("source-allevents").lastError).toContain(
      "трёх ответов блокировки",
    );
    expect(sync.runs()[0].status).toBe("error");
  });

  it("stores the complete card in the dedicated raw table", () => {
    const ctx = context();
    const raw = parseAllEventsEvent(event("stored-1"), ctx);
    const normalized = allEvents.normalize(raw, ctx)!;
    store.ingest(ctx.source, [{ raw, entity: normalized }]);
    const row = store.db
      .prepare(
        "SELECT eventId,rawPayload,categorySlugs FROM allevents_raw_events WHERE sourceId=?",
      )
      .get(ctx.source.id) as any;
    expect(row.eventId).toBe("stored-1");
    expect(JSON.parse(row.rawPayload).organizer.name).toBe("Local promoter");
    expect(JSON.parse(row.categorySlugs)).toContain("music");
  });
});

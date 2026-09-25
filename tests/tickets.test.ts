import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import tickets, {
  parseTicketsEvent,
} from "../server/providers/websites/tickets";
import { fetchJson } from "../server/providers/http";
import type { ProviderContext } from "../server/providers/types";
vi.mock("../server/providers/http", () => ({ fetchJson: vi.fn() }));
const request = vi.mocked(fetchJson);
const town = { ID: 8918, Title: "Beograd" };
const zemun = { ID: 164, Title: "Beograd (Zemun)" };
const event = (Id = 1, overrides = {}) => ({
  Id,
  Slug: `event/concert_${Id}`,
  Type: "event",
  Title: "Концерт",
  Desc: "<p>Описание</p>",
  DateTime: "25. septembar 2026 20:00",
  StartDate: "2026-09-25",
  EndDate: "2026-09-25",
  Venue: "Club",
  Price: 1200,
  EventStatus: "",
  ImgSrc: "https://assets.tickets.rs/concert.png",
  ...overrides,
});
let store: Store, ctx: ProviderContext;
beforeEach(() => {
  store = new Store(":memory:");
  ctx = {
    source: { ...store.source("source-tickets"), enabled: true },
    scope: store.scope("belgrade"),
    secrets: {},
  };
  request.mockReset();
});
afterEach(() => store.close());
function mockAPI(
  pages: Record<number, unknown[][]>,
  transform = (data: any) => data,
) {
  request.mockImplementation(async (url, init) => {
    if (url.endsWith("app_config.json"))
      return {
        UserName: "tickets.rs",
        UserType: "2",
        SessionCode: "public-test-config",
      };
    const { sproc, JSONParams: p } = JSON.parse(String(init?.body));
    let data;
    if (sproc === "web__Get_PageConfig")
      data = {
        Layout: { Columns: [{ Widgets: [{ Type: "event-list", Id: 45 }] }] },
      };
    else if (sproc === "web__Get_SearchMenu")
      data = { Town: [town, zemun, { ID: 492, Title: "Novi Sad" }] };
    else {
      const pagesForTown = pages[p.Search.IDTown] || [[]];
      data = transform({
        TotalItems: pagesForTown.flat().length,
        ItemsPerPage: 1,
        CurrentPage: p.CurrentPage,
        Events: pagesForTown[p.CurrentPage - 1] || [],
        Toolbar: {
          Filters: [
            {
              Key: "IDTown",
              Groups: [{ Options: [{ ID: p.Search.IDTown, Selected: true }] }],
            },
          ],
        },
      });
    }
    return { RetMessage: "OK", data };
  });
}
describe("Tickets.rs public website adapter", () => {
  it("reads exact dates, Belgrade timezone, price and provenance", () => {
    const raw = event();
    const item = parseTicketsEvent(raw, town, ctx)!;
    const entity = tickets.normalize(item, ctx)!;
    expect(entity).toMatchObject({
      city: "Belgrade",
      country: "RS",
      startAt: "2026-09-25T18:00:00.000Z",
      endAt: "",
      description: "Описание",
      knownIds: { tickets: "1" },
      price: "от 1 200 RSD",
    });
    expect((item.payload as any).original).toEqual(raw);
    expect(item.url).toBe("https://tickets.rs/event/concert_1");
  });
  it("uses winter offset, preserves unknown time and avoids claiming a zero price is free", () => {
    const item = parseTicketsEvent(
      event(1, {
        StartDate: "2026-11-25",
        EndDate: "2026-11-25",
        DateTime: "25. novembar 2026 20:00",
      }),
      town,
      ctx,
    )!;
    expect(tickets.normalize(item, ctx)!.startAt).toBe(
      "2026-11-25T19:00:00.000Z",
    );
    const day = parseTicketsEvent(
      event(2, { DateTime: "25.septembar 2026", Price: 0 }),
      town,
      ctx,
    )!;
    expect(tickets.normalize(day, ctx)).toMatchObject({
      startAt: "2026-09-25",
      price: "",
    });
  });
  it("skips undated vouchers and validates invalid dates and links", () => {
    expect(parseTicketsEvent(event(1, { DateTime: "" }), town, ctx)).toBeNull();
    expect(
      tickets.normalize(
        parseTicketsEvent(
          event(1, {
            DateTime: "Prodaja ulaznica na Beogradskoj tvrđavi",
            StartDate: "2028-12-31",
            EndDate: "2028-12-31",
          }),
          town,
          ctx,
        )!,
        ctx,
      )!.startAt,
    ).toBe("");
    expect(() =>
      parseTicketsEvent(event(1, { StartDate: "2026-02-30" }), town, ctx),
    ).toThrow();
    expect(() =>
      parseTicketsEvent(event(1, { Slug: "https://other.test/1" }), town, ctx),
    ).toThrow();
    expect(() =>
      parseTicketsEvent(event(1, { ImgSrc: "javascript:alert(1)" }), town, ctx),
    ).toThrow();
  });
  it("handles Serbian hour notation and keeps separate performances distinct", () => {
    const records = ["12h", "17h", "20.00", "10:00-15:00"].map((time, i) => {
      const raw = parseTicketsEvent(
        event(i + 1, { DateTime: `nedelja 25.septembar ${time}` }),
        town,
        ctx,
      )!;
      return { raw, entity: tickets.normalize(raw, ctx)! };
    });
    expect(records.map(({ entity }) => entity.startAt)).toEqual([
      "2026-09-25T10:00:00.000Z",
      "2026-09-25T15:00:00.000Z",
      "2026-09-25T18:00:00.000Z",
      "2026-09-25T08:00:00.000Z",
    ]);
    expect(store.ingest(ctx.source, records).created).toBe(4);
    expect(store.ingest(ctx.source, records).duplicates).toBe(4);
  });
  it("paginates the city and Zemun, deduplicates overlaps and sends keyword and current day", async () => {
    mockAPI({ 8918: [[event(1)], [event(2)]], 164: [[event(2)]] });
    ctx.source.keyword = "Jazz";
    const result = await tickets.sync(ctx);
    expect(result.items.map((row) => row.externalId)).toEqual(["1", "2"]);
    expect(result.warnings).toEqual([]);
    const calls = request.mock.calls
      .filter(([, init]) => init?.body)
      .map(([, init]) => JSON.parse(String(init!.body)));
    expect(
      calls
        .filter((call) => call.sproc === "web__Get_EventList")
        .map((call) => [
          call.JSONParams.Search.IDTown,
          call.JSONParams.CurrentPage,
        ]),
    ).toEqual([
      [8918, 1],
      [8918, 2],
      [164, 1],
    ]);
    expect(calls[2].JSONParams.Search).toMatchObject({
      Text: "Jazz",
      DateFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(JSON.stringify(result)).not.toContain("public-test-config");
  });
  it("validates a real first page during Test without downloading the whole catalog", async () => {
    mockAPI({ 8918: [[event(1)], [event(2)]] });
    expect(await tickets.testConnection(ctx)).toContain("2 записей");
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("rejects changed HTML/config and does not fetch user-supplied arbitrary URLs", async () => {
    ctx.source.url = "https://other.test/";
    await expect(tickets.sync(ctx)).rejects.toThrow(
      "укажите https://tickets.rs/",
    );
    expect(request).not.toHaveBeenCalled();
    ctx.source.url = "https://tickets.rs/";
    request.mockResolvedValue("<html>New page</html>");
    await expect(tickets.sync(ctx)).rejects.toThrow("конфигурацию");
  });
  it("rejects ignored city filters and repeated pagination instead of silently importing wrong data", async () => {
    mockAPI({ 8918: [[event(1)]] }, (data) => ({
      ...data,
      Toolbar: { Filters: [] },
    }));
    await expect(tickets.sync(ctx)).rejects.toThrow("фильтр города");
    mockAPI({ 8918: [[event(1)], [event(1)]] });
    await expect(tickets.sync(ctx)).rejects.toThrow("повторил события");
    mockAPI({ 8918: [[event(1)], [event(2)]] }, (data) => ({
      ...data,
      CurrentPage: 1,
    }));
    await expect(tickets.sync(ctx)).rejects.toThrow("повторную страницу");
  });
  it("reports skipped items and rejects a fully unparseable page", async () => {
    mockAPI({ 8918: [[event(1)], [event(2, { DateTime: "" })], [{}]] });
    const result = await tickets.sync(ctx);
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    mockAPI({ 8918: [[{}]] });
    await expect(tickets.sync(ctx)).rejects.toThrow("ни одну запись");
  });
  it("allows a genuine empty result and keeps unsupported geographies unavailable", async () => {
    mockAPI({ 8918: [[]], 164: [[]] }, (data) => ({
      ...data,
      CurrentPage: 0,
      Toolbar: { Filters: [] },
    }));
    expect((await tickets.sync(ctx)).items).toEqual([]);
    ctx.scope = store.scope("serbia");
    expect(tickets.connectionStatus(ctx).canSync).toBe(false);
  });
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { AiDigests } from "../server/ai-digests.js";
import {
  autoArchivePastEvents,
  saveAutoArchiveSettings,
} from "../server/auto-archive.js";
import {
  aiDigestInputSchema,
  sortDigests,
  filterDigestItems,
  digestDays,
  digestDayLabel,
  digestTitle,
} from "../shared/ai-digests.js";
import { AiDigestCard, AiDigestDetails } from "../src/AiDigests.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const now = new Date("2026-10-03T12:00:00Z");
const fixture = () => ({
  id: randomUUID(),
  scopeId: "belgrade",
  title: "Выходные",
  requestSummary: "Активности в Белграде 10–11 октября",
  startDate: "2026-10-10",
  endDate: "2026-10-11",
  items: [
    {
      title: "Фестиваль",
      description: "Дегустации. 200 RSD / донат для гостей",
      startAt: "2026-10-09",
      endAt: "2026-10-12",
      aiScore: 8.3,
      sourceName: "Канал",
      sourceUrl: "https://t.me/example/1",
      eventUrl: "https://example.com/event",
    },
  ],
});

it("stores a snapshot, supports safe retry and rejects ID overwrite", () => {
  const service = new AiDigests(store),
    input = fixture(),
    saved = service.create(input, now);
  expect(saved).toMatchObject({
    title: input.title,
    archivedAt: null,
    items: input.items,
  });
  expect(service.create(input, now)).toEqual(saved);
  expect(service.list("belgrade", false)).toHaveLength(1);
  expect(() => service.create({ ...input, title: "Changed" }, now)).toThrow(
    /ID/,
  );
  expect(service.get(input.id)).toEqual(saved);
  expect(store.entities()).toHaveLength(0);
});
it("archives only after the entire digest period and preserves rows and links", () => {
  const service = new AiDigests(store),
    input = fixture();
  service.create(input, now);
  expect(service.archivePast("belgrade", "2026-10-11").archived).toBe(0);
  expect(service.archivePast("belgrade", "2026-10-12").archived).toBe(1);
  expect(service.archivePast("belgrade", "2026-10-13").archived).toBe(0);
  expect(service.list("belgrade", false)).toHaveLength(0);
  expect(service.list("belgrade", true)[0].items[0].sourceUrl).toBe(
    input.items[0].sourceUrl,
  );
});
it("respects automatic archive opt-out, timezone and scope", () => {
  const service = new AiDigests(store);
  const city = service.create(fixture(), now),
    country = service.create({ ...fixture(), scopeId: "serbia" }, now);
  saveAutoArchiveSettings(store, { enabled: false });
  autoArchivePastEvents(store, undefined, new Date("2026-10-12T12:00:00Z"));
  expect(service.get(city.id)?.archivedAt).toBeNull();
  saveAutoArchiveSettings(store, { enabled: true });
  autoArchivePastEvents(store, "belgrade", new Date("2026-10-11T23:30:00Z"));
  expect(service.get(city.id)?.archivedAt).toBeTruthy();
  expect(service.get(country.id)?.archivedAt).toBeNull();
  expect(service.archivePast("serbia", "2026-10-12").archived).toBe(1);
  expect(service.list("serbia", true)).toHaveLength(2);
});
it("rejects invalid dates, reversed ranges, out-of-period events, unsafe URLs and scores", () => {
  const service = new AiDigests(store),
    input = fixture(),
    item = input.items[0];
  for (const patch of [
    { startDate: "2026-02-30" },
    { endDate: "2026-10-09" },
    { scopeId: "missing" },
    { items: [{ ...item, startAt: "2026-10-13", endAt: "" }] },
    { items: [{ ...item, endAt: "2026-10-08" }] },
    { items: [{ ...item, sourceUrl: "javascript:alert(1)" }] },
    { items: [{ ...item, aiScore: 11 }] },
  ])
    expect(() => service.create({ ...input, ...patch }, now)).toThrow();
  expect(service.list("belgrade", false)).toHaveLength(0);
});
it("supports single-day empty historical digests and stable date sorting", () => {
  const service = new AiDigests(store);
  expect(
    service.create(
      {
        ...fixture(),
        items: [],
        startDate: "2026-10-01",
        endDate: "2026-10-01",
      },
      now,
    ).archivedAt,
  ).toBeTruthy();
  const first = service.create(fixture(), now),
    later = service.create(
      { ...fixture(), startDate: "2026-10-09", endDate: "2026-10-12" },
      now,
    );
  const rows = [later, first];
  expect(sortDigests(rows, "asc").map((d) => d.id)).toEqual([
    first.id,
    later.id,
  ]);
  expect(rows[0]).toBe(later);
  expect(sortDigests(rows, "desc")[0]).toBe(later);
});
it("renders collapsed cards and separate four-column day-grouped details safely", () => {
  const digest = {
    ...aiDigestInputSchema.parse(fixture()),
    createdAt: now.toISOString(),
    archivedAt: null,
  };
  const html = renderToStaticMarkup(
    <AiDigestDetails digest={digest} timeZone="Europe/Belgrade" />,
  );
  for (const value of [
    "<table",
    "<thead",
    "Запрос:",
    "Мероприятие и описание",
    "Дата события",
    "AI-score",
    "Источник",
    "200 RSD",
    "2026-10-09",
    "2026-10-12",
    "https://t.me/example/1",
    "https://example.com/event",
    "8,3",
  ])
    expect(html).toContain(value);
  expect(html).toContain('rel="noreferrer"');
  expect(
    renderToStaticMarkup(
      <AiDigestCard
        onOpen={() => {}}
        digest={{ ...digest, title: "<script>alert(1)</script>" }}
        timeZone="Europe/Belgrade"
      />,
    ),
  ).not.toContain("<script>");
  const card = renderToStaticMarkup(
    <AiDigestCard
      digest={digest}
      timeZone="Europe/Belgrade"
      onOpen={() => {}}
    />,
  );
  expect(card).not.toContain("<table");
  expect(card).not.toContain("200 RSD");
  expect(card).toContain("Событий: 1");
  expect(card).toContain('aria-haspopup="dialog"');
  expect(html.match(/<table/g)).toHaveLength(2);
  expect(html.match(/<th scope="col"/g)).toHaveLength(8);
  expect(html).toContain("10 октября 2026, суббота");
  expect(html).toContain("11 октября 2026, воскресенье");
});

const filters = { from: "", to: "", minScore: 0, tags: [] as string[] };
it("formats digest titles with a trailing period without repeating existing dates", () => {
  const base = {
    title: "Выходные",
    startDate: "2026-10-15",
    endDate: "2026-10-16",
  };
  expect(digestTitle(base)).toBe("Выходные · 15–16 октября");
  expect(digestTitle({ ...base, title: "Выходные · 15–16 октября" })).toBe(
    "Выходные · 15–16 октября",
  );
  expect(
    digestTitle({ ...base, title: "Выходные 15-16 октября: Белград" }),
  ).toBe("Выходные: Белград · 15–16 октября");
  expect(digestTitle({ ...base, endDate: base.startDate })).toBe(
    "Выходные · 15 октября",
  );
  expect(
    digestTitle({ ...base, startDate: "2026-10-30", endDate: "2026-11-02" }),
  ).toBe("Выходные · 30 октября – 2 ноября");
  expect(
    digestTitle({ ...base, startDate: "2026-12-31", endDate: "2027-01-02" }),
  ).toBe("Выходные · 31 декабря 2026 – 2 января 2027");
  expect(digestTitle({ ...base, title: "Музыка 90-х" })).toBe(
    "Музыка 90-х · 15–16 октября",
  );
});
it("filters score, inclusive dates and any selected tag, counting intervals only once", () => {
  const digest = new AiDigests(store).create(fixture(), now);
  digest.items[0].tags = ["туризм", "хайкинг"];
  digest.items.push({
    ...digest.items[0],
    title: "Концерт",
    aiScore: 6,
    tags: ["музыка"],
    startAt: "2026-10-11",
    endAt: "",
  });
  const selected = {
    ...filters,
    from: "2026-10-11",
    minScore: 8,
    tags: ["музыка", "хайкинг"],
  };
  const items = filterDigestItems(digest, selected, "Europe/Belgrade");
  expect(items).toHaveLength(1);
  expect(
    [...digestDays(digest, items, selected, "Europe/Belgrade")].map(
      (g) => g.day,
    ),
  ).toEqual(["2026-10-11"]);
  expect(
    filterDigestItems(digest, { ...filters, minScore: 8.5 }, "Europe/Belgrade"),
  ).toEqual([]);
  expect(
    filterDigestItems(
      digest,
      { ...filters, tags: ["танцы"] },
      "Europe/Belgrade",
    ),
  ).toEqual([]);
  expect(
    filterDigestItems(
      digest,
      { ...filters, from: "2026-10-12" },
      "Europe/Belgrade",
    ),
  ).toEqual([]);
  expect(
    filterDigestItems(
      digest,
      { ...filters, from: "2026-10-11", to: "2026-10-10" },
      "Europe/Belgrade",
    ),
  ).toEqual([]);
});
it("groups in the scope timezone across midnight and DST without losing or duplicating days", () => {
  const digest = new AiDigests(store).create(
    {
      ...fixture(),
      startDate: "2026-10-24",
      endDate: "2026-10-26",
      items: [
        {
          ...fixture().items[0],
          startAt: "2026-10-23T23:30:00Z",
          endAt: "2026-10-25T23:30:00Z",
        },
      ],
    },
    now,
  );
  expect(
    [...digestDays(digest, digest.items, filters, "Europe/Belgrade")].map(
      (g) => g.day,
    ),
  ).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  expect(digestDayLabel("2026-10-25")).toBe("25 октября 2026, воскресенье");
  expect([...digestDays(digest, [], filters, "Europe/Belgrade")]).toEqual([]);
});
it("normalizes legacy snapshots and updates only tags with stale-write protection", () => {
  const service = new AiDigests(store),
    input = fixture();
  service.create(input, now);
  // Simulate a pre-tags snapshot, including its old JSON key order.
  store.db
    .prepare("UPDATE ai_digests SET data=? WHERE id=?")
    .run(JSON.stringify({ ...input, notes: "" }), input.id);
  const legacy = service.get(input.id)!;
  expect(legacy.items[0].tags).toEqual([]);
  expect(service.create(input, now)).toEqual(legacy);
  const updated = service.updateTags(input.id, {
    expectedItems: legacy.items,
    tags: [["Хайкинг", "хайкинг", "туризм"]],
  });
  expect(updated.items[0].tags).toEqual(["хайкинг", "туризм"]);
  expect(updated.createdAt).toBe(legacy.createdAt);
  expect(updated.items[0].description).toBe(legacy.items[0].description);
  expect(() =>
    service.updateTags(input.id, { expectedItems: legacy.items, tags: [[]] }),
  ).toThrow(/изменились/);
  expect(() =>
    service.updateTags(input.id, { expectedItems: updated.items, tags: [] }),
  ).toThrow(/каждой/);
  expect(() =>
    service.updateTags(input.id, {
      expectedItems: updated.items,
      tags: [["#invalid"]],
    }),
  ).toThrow();
  const html = renderToStaticMarkup(
    <AiDigestDetails digest={updated} timeZone="Europe/Belgrade" />,
  );
  expect(html).toContain("#хайкинг #туризм");
  expect(html).toContain('aria-pressed="false"');
});

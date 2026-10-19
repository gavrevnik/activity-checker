import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import { RejectedRecommendationList } from "../src/Recommendations.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const now = new Date("2026-10-19T10:00:00Z");
const card = (
  title = "Местный концерт",
  startAt = "2026-10-20T19:00:00+03:00",
) => ({
  title,
  startAt,
  endAt: "",
  description: "Полное описание программы.",
  aiScore: 2,
  group: "concerts" as const,
  tags: [],
  sourceName: "Афиша",
  sourceUrl: "https://example.org/list",
  eventUrl: `https://example.org/${encodeURIComponent(title)}`,
  rejectionReason: "Низкое совпадение с музыкальным профилем.",
});
const payload = () => ({
  id: randomUUID(),
  scopeId: "chisinau",
  kind: "week" as const,
  startDate: "2026-10-19",
  endDate: "2026-10-25",
  settingsRevision: 0,
  expectedSnapshotId: null,
  requestSummary: "Текущая неделя",
  items: [],
  rejectedItems: [card()],
});

it("stores reviewed rejections separately and supports legacy snapshots and idempotent retries", () => {
  const service = new Recommendations(store);
  const input = payload();
  service.publish(input, now);
  const view = service.view("chisinau", "week", now);
  expect(view.snapshot?.items).toEqual([]);
  expect(view.rejected).toEqual(input.rejectedItems);
  expect(service.publish(input, now)).toEqual(view.snapshot);
  expect(service.view("belgrade", "week", now).rejected).toEqual([]);
  const { rejectedItems: _, ...legacy } = payload();
  service.publish({ ...legacy, expectedSnapshotId: input.id }, now);
  expect(service.view("chisinau", "week", now).rejected).toEqual([]);
});

it("hides and expires rejected cards, without duplicating favorites restored to the calendar", () => {
  const service = new Recommendations(store),
    input = payload();
  service.publish(input, now);
  const { rejectionReason: _, ...item } = input.rejectedItems[0];
  service.hide({ scopeId: "chisinau", item }, now);
  expect(service.view("chisinau", "week", now).rejected).toEqual([]);
  const [hidden] = service.hidden("chisinau", now);
  service.restore({ scopeId: "chisinau", id: hidden.id }, now);
  expect(service.view("chisinau", "week", now).snapshot?.items).toHaveLength(1);
  expect(service.view("chisinau", "week", now).rejected).toEqual([]);
  expect(
    service.view("chisinau", "week", new Date("2026-10-21T10:00:00Z")).snapshot
      ?.items,
  ).toEqual([]);
  expect(
    service.view("chisinau", "week", new Date("2026-10-21T10:00:00Z")).rejected,
  ).toEqual([]);
});

it("validates dates, reasons, groups and duplicate identities across both lists", () => {
  const service = new Recommendations(store);
  expect(() =>
    service.publish(
      { ...payload(), rejectedItems: [card("Позже", "2026-10-26")] },
      now,
    ),
  ).toThrow(/периода/);
  expect(() =>
    service.publish(
      { ...payload(), rejectedItems: [{ ...card(), rejectionReason: "" }] },
      now,
    ),
  ).toThrow();
  const { rejectionReason: _, ...accepted } = card();
  expect(() =>
    service.publish({ ...payload(), items: [accepted] }, now),
  ).toThrow(/повторные/);
  expect(() =>
    service.publish({ ...payload(), rejectedItems: [card(), card()] }, now),
  ).toThrow(/повторные/);
  expect(() =>
    service.publish(
      {
        ...payload(),
        kind: "concerts-2026",
        endDate: "2026-12-31",
        rejectedItems: [{ ...card(), group: "sport" }],
      },
      now,
    ),
  ).toThrow();
});

it("renders ordinary full cards in chronological local-day sections with score and rejection reason", () => {
  const html = renderToStaticMarkup(
    <RejectedRecommendationList
      timeZone="Europe/Chisinau"
      items={[
        card("Поздний день", "2026-10-21"),
        card("Раньше по времени", "2026-10-20T21:00:00+03:00"),
        card("Позже по времени", "2026-10-20T19:00:00Z"),
        card("Ночь по местному времени", "2026-10-19T23:30:00Z"),
      ]}
    />,
  );
  expect(html.indexOf("20 октября")).toBeLessThan(html.indexOf("21 октября"));
  expect(html).toContain("Ночь по местному времени");
  expect(html.indexOf("Раньше по времени")).toBeLessThan(
    html.indexOf("Позже по времени"),
  );
  expect(html).toContain("Полное описание программы.");
  expect(html).toContain("Оценка: 2/10");
  expect(html).toContain("Низкое совпадение с музыкальным профилем.");
  expect(html).toContain("recommendation-card");
});

it("keeps separate performances on the same day in their respective lists", () => {
  const service = new Recommendations(store);
  const { rejectionReason: _, ...accepted } = card(
    "Две программы",
    "2026-10-20T16:00:00+03:00",
  );
  service.publish(
    {
      ...payload(),
      items: [accepted],
      rejectedItems: [card("Две программы", "2026-10-20T20:00:00+03:00")],
    },
    now,
  );
  const view = service.view("chisinau", "week", now);
  expect(view.snapshot?.items).toHaveLength(1);
  expect(view.rejected).toHaveLength(1);
});

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import {
  remainingWeek,
  type RecommendationItem,
} from "../shared/recommendations.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const now = new Date("2026-10-13T10:00:00Z");
const item = (): RecommendationItem => ({
  title: "Разговорный клуб",
  description: "Общение. Подробности участия.",
  startAt: "2026-10-14T19:30:00+02:00",
  endAt: "",
  group: "social",
  aiScore: 8,
  sourceName: "Канал встреч",
  sourceUrl: "https://t.me/meetings/123",
  eventUrl: "",
  tags: [],
});
const publish = (service: Recommendations, items = [item()]) =>
  service.publish(
    {
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "week",
      startDate: "2026-10-13",
      endDate: "2026-10-18",
      settingsRevision: 0,
      expectedSnapshotId: service.latest("belgrade", "week")?.id || null,
      requestSummary: "Неделя",
      items,
    },
    now,
  );

it("filters unscored candidates deterministically before analysis, including a new Telegram announcement", () => {
  const service = new Recommendations(store);
  const hidden = service.hide({ scopeId: "belgrade", item: item() }, now);
  expect(new Recommendations(store).hidden("belgrade", now)[0].id).toBe(
    hidden.id,
  );
  const {
    description: _,
    aiScore: __,
    group: ___,
    tags: ____,
    ...candidate
  } = item();
  const changed = {
    ...candidate,
    title: "РАЗГОВОРНЫЙ — КЛУБ!",
    sourceName: "Новое название канала",
    sourceUrl: "https://t.me/s/Meetings/999",
    startAt: "2026-10-14T18:00:00+02:00",
    rawText: "Длинный текст",
  };
  const tomorrow = { ...candidate, startAt: "2026-10-15T19:30:00+02:00" };
  const different = {
    ...candidate,
    sourceName: "Другой канал",
    sourceUrl: "https://t.me/other/123",
  };
  const result = service.filterCandidates(
    { scopeId: "belgrade", candidates: [changed, tomorrow, different] },
    now,
  );
  expect(result.excludedCount).toBe(1);
  expect(result.candidates.map((c) => c.startAt)).toEqual([
    tomorrow.startAt,
    different.startAt,
  ]);
  expect(
    service.filterCandidates({ scopeId: "serbia", candidates: [changed] }, now)
      .excludedCount,
  ).toBe(0);
});

it("recognizes the same event across sources via an event URL without tracking parameters", () => {
  const service = new Recommendations(store);
  service.hide(
    {
      scopeId: "belgrade",
      item: {
        ...item(),
        eventUrl: "http://www.example.org/show/?utm_source=tg",
      },
    },
    now,
  );
  expect(
    service.filterCandidates(
      {
        scopeId: "belgrade",
        candidates: [
          {
            ...item(),
            title: "Обновлённое название",
            sourceName: "Афиша",
            sourceUrl: "https://afisha.rs/new",
            eventUrl: "https://example.org/show",
          },
        ],
      },
      now,
    ).excludedCount,
  ).toBe(1);
});

it("does not conflate different events listed in the same Telegram post", () => {
  const service = new Recommendations(store);
  service.hide(
    { scopeId: "belgrade", item: { ...item(), eventUrl: item().sourceUrl } },
    now,
  );
  expect(
    service.filterCandidates(
      {
        scopeId: "belgrade",
        candidates: [
          {
            ...item(),
            title: "Караоке",
            eventUrl: item().sourceUrl,
            rawText: "Сохраняется вместе с кандидатом",
          },
        ],
      },
      now,
    ).candidates[0].rawText,
  ).toContain("Сохраняется");
});

it("hides in both tabs, survives snapshot refresh and restores even after omission from the latest snapshot", () => {
  const service = new Recommendations(store),
    concert = { ...item(), group: "concerts" as const };
  publish(service, [concert]);
  service.publish(
    {
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "concerts-2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      settingsRevision: 0,
      expectedSnapshotId: null,
      requestSummary: "Год",
      items: [concert],
    },
    now,
  );
  const hidden = service.hide({ scopeId: "belgrade", item: concert }, now);
  expect(service.hide({ scopeId: "belgrade", item: concert }, now).id).toBe(
    hidden.id,
  );
  expect(service.view("belgrade", "week", now).snapshot?.items).toEqual([]);
  expect(
    service.view("belgrade", "concerts-2026", now).snapshot?.items,
  ).toEqual([]);
  publish(service, []);
  service.restore({ scopeId: "belgrade", id: hidden.id }, now);
  expect(service.hidden("belgrade", now)).toEqual([]);
  expect(service.view("belgrade", "week", now).snapshot?.items).toEqual([
    concert,
  ]);
  expect(service.hide({ scopeId: "belgrade", item: concert }, now).id).toBe(
    hidden.id,
  );
  expect(() =>
    service.restore({ scopeId: "serbia", id: hidden.id }, now),
  ).toThrow(/не найдено/);
});

it("enforces hidden exclusions at publication while preserving immutable idempotent request history", () => {
  const service = new Recommendations(store);
  const payload = {
    id: randomUUID(),
    scopeId: "belgrade",
    kind: "week",
    startDate: "2026-10-13",
    endDate: "2026-10-18",
    settingsRevision: 0,
    expectedSnapshotId: null,
    requestSummary: "Подборка",
    items: [item()],
  };
  service.hide({ scopeId: "belgrade", item: item() }, now);
  expect(service.publish(payload, now).items).toEqual([]);
  expect(service.publish(payload, now).items).toEqual([]);
  expect(() =>
    service.publish({ ...payload, requestSummary: "Changed" }, now),
  ).toThrow(/ID/);
});

it("expires hidden rows using real end time or local date, including DST, and cannot restore expired rows", () => {
  const service = new Recommendations(store);
  const hidden = service.hide(
    { scopeId: "belgrade", item: { ...item(), startAt: "2026-10-25" } },
    now,
  );
  expect(
    service.hidden("belgrade", new Date("2026-10-25T22:59:00Z")),
  ).toHaveLength(1);
  expect(service.hidden("belgrade", new Date("2026-10-25T23:00:00Z"))).toEqual(
    [],
  );
  expect(
    store.db.prepare("SELECT count(*) n FROM recommendation_visibility").get()
      ?.n,
  ).toBe(0);
  expect(() =>
    service.restore(
      { scopeId: "belgrade", id: hidden.id },
      new Date("2026-10-26T00:00:00Z"),
    ),
  ).toThrow(/прошло/);
  service.hide(
    {
      scopeId: "belgrade",
      item: { ...item(), endAt: "2026-10-14T22:00:00+02:00" },
    },
    now,
  );
  expect(
    service.hidden("belgrade", new Date("2026-10-14T19:00:00Z")),
  ).toHaveLength(1);
  expect(service.cleanupVisibility(new Date("2026-10-14T20:01:00Z"))).toBe(1);
});

it("drops previous start days at local midnight even for an event that continues, without rewriting snapshot history", () => {
  const service = new Recommendations(store);
  const Tuesday = {
    ...item(),
    startAt: "2026-10-13T18:00:00+02:00",
    endAt: "2026-10-15",
  };
  const saved = publish(service, [Tuesday, item()]);
  const view = service.view(
    "belgrade",
    "week",
    new Date("2026-10-13T22:00:00Z"),
  );
  expect(view.period.startDate).toBe("2026-10-14");
  expect(remainingWeek(view.period.startDate)[0]).toBe("2026-10-14");
  expect(view.snapshot?.items).toEqual([item()]);
  expect(service.latest("belgrade", "week")?.items).toHaveLength(2);
  expect(view.snapshot?.id).toBe(saved.id);
});

it("persists recommendation favorites independently and keeps the general list unchanged when toggled", () => {
  const service = new Recommendations(store);
  const saved = publish(service);
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: true },
    now,
  );
  const favorite = new Recommendations(store).favorites("belgrade", now)[0];
  expect(favorite.item).toEqual(item());
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: true },
    new Date(now.valueOf() + 1000),
  );
  expect(service.favorites("belgrade", now)).toEqual([favorite]);
  expect(service.view("belgrade", "week", now).snapshot).toEqual(saved);
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: false },
    now,
  );
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: false },
    now,
  );
  expect(service.favorites("belgrade", now)).toEqual([]);
  expect(service.view("belgrade", "week", now).snapshot).toEqual(saved);
  expect(store.entities()).toHaveLength(0);
});

it("keeps planned events when a newer recommendation snapshot omits them", () => {
  const service = new Recommendations(store);
  publish(service);
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: true },
    now,
  );
  const next = publish(service, []);
  expect(service.view("belgrade", "week", now).snapshot?.items).toEqual([
    item(),
  ]);
  expect(service.view("belgrade", "week", now).snapshot?.id).toBe(next.id);
  expect(service.latest("belgrade", "week")?.items).toEqual([]);
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: false },
    now,
  );
  expect(service.view("belgrade", "week", now).snapshot?.items).toEqual([]);
});

it("shares favorites and hiding between the annual and weekly calendars through yearly refreshes", () => {
  const service = new Recommendations(store);
  const concert = { ...item(), group: "concerts" as const };
  publish(service, [concert]);
  const annual = service.publish(
    {
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "concerts-2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      settingsRevision: 0,
      expectedSnapshotId: null,
      requestSummary: "Концерты и фестивали 2026",
      items: [concert],
    },
    now,
  );
  service.saveFavorite(
    { scopeId: "belgrade", item: concert, favorite: true },
    now,
  );
  expect(service.view("belgrade", "week", now).favorites).toHaveLength(1);
  expect(service.view("belgrade", "concerts-2026", now).favorites).toHaveLength(
    1,
  );
  const { updatedAt: _, ...annualPayload } = annual;
  service.publish(
    {
      ...annualPayload,
      id: randomUUID(),
      expectedSnapshotId: annual.id,
      items: [],
    },
    now,
  );
  expect(
    service.view("belgrade", "concerts-2026", now).snapshot?.items,
  ).toEqual([concert]);
  const hidden = service.hide({ scopeId: "belgrade", item: concert }, now);
  expect(service.view("belgrade", "week", now).snapshot?.items).toEqual([]);
  expect(
    service.view("belgrade", "concerts-2026", now).snapshot?.items,
  ).toEqual([]);
  service.restore({ scopeId: "belgrade", id: hidden.id }, now);
  expect(
    service.view("belgrade", "concerts-2026", now).snapshot?.items,
  ).toEqual([concert]);
  service.saveFavorite(
    { scopeId: "belgrade", item: concert, favorite: false },
    now,
  );
  expect(service.view("belgrade", "concerts-2026", now).favorites).toEqual([]);
  expect(service.view("belgrade", "week", now).favorites).toEqual([]);
});

it("recognizes changed announcement metadata and lets hiding take priority without removing the favorite", () => {
  const service = new Recommendations(store);
  publish(service);
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: true },
    now,
  );
  const changed = {
    ...item(),
    title: "РАЗГОВОРНЫЙ КЛУБ!",
    sourceUrl: "https://t.me/meetings/999",
    startAt: "2026-10-14T20:00:00+02:00",
  };
  service.saveFavorite(
    { scopeId: "belgrade", item: changed, favorite: true },
    now,
  );
  expect(service.favorites("belgrade", now)).toHaveLength(1);
  const hidden = service.hide({ scopeId: "belgrade", item: changed }, now);
  expect(service.view("belgrade", "week", now).snapshot?.items).toEqual([]);
  expect(service.view("belgrade", "week", now).favorites).toHaveLength(1);
  service.restore({ scopeId: "belgrade", id: hidden.id }, now);
  expect(service.view("belgrade", "week", now).snapshot?.items).toHaveLength(1);
  service.saveFavorite(
    { scopeId: "belgrade", item: item(), favorite: false },
    now,
  );
  expect(service.favorites("belgrade", now)).toHaveLength(0);
  expect(service.favorites("serbia", now)).toHaveLength(0);
});

it("expires favorites and does not favorite past events or another occurrence", () => {
  const service = new Recommendations(store);
  const dateOnly = { ...item(), startAt: "2026-10-14" };
  service.saveFavorite(
    { scopeId: "belgrade", item: dateOnly, favorite: true },
    now,
  );
  service.saveFavorite(
    {
      scopeId: "belgrade",
      item: { ...dateOnly, startAt: "2026-10-15" },
      favorite: true,
    },
    now,
  );
  expect(service.favorites("belgrade", now)).toHaveLength(2);
  expect(
    service.favorites("belgrade", new Date("2026-10-14T22:00:00Z")),
  ).toHaveLength(1);
  expect(() =>
    service.saveFavorite(
      { scopeId: "belgrade", item: dateOnly, favorite: true },
      new Date("2026-10-14T22:00:00Z"),
    ),
  ).toThrow(/прошло/);
  expect(service.favorites("serbia", now)).toHaveLength(0);
});

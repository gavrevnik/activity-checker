import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import {
  recommendationInputSchema,
  recommendationSlots,
} from "../shared/recommendations.js";

let store: Store;
const now = new Date("2026-10-15T10:00:00Z");
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const input = () => ({
  id: randomUUID(),
  scopeId: "belgrade",
  day: "2026-10-17",
  hour: 19,
  title: "Моя встреча",
  description: "Первое предложение. Полные условия встречи.",
});
it("keeps personal entries outside model snapshots, supports deletion/restoration and independent favorites", () => {
  const service = new Recommendations(store),
    payload = input();
  const item = service.addPersonal(payload, now);
  expect(item.startAt).toBe("2026-10-17T17:00:00.000Z");
  expect(service.view("belgrade", "week", now).snapshot).toBeNull();
  expect(
    new Recommendations(store).view("belgrade", "week", now).personal,
  ).toEqual([item]);
  expect(service.personal("serbia", now)).toEqual([]);
  service.updatePersonal(
    { scopeId: "belgrade", id: item.id, favorite: true },
    now,
  );
  service.updatePersonal(
    { scopeId: "belgrade", id: item.id, deleted: true },
    now,
  );
  const deleted = service.personal("belgrade", now)[0];
  expect(deleted.deletedAt).toBe(now.toISOString());
  expect(deleted.favorite).toBe(true);
  expect(service.addPersonal(payload, now)).toEqual(deleted);
  service.publish(
    {
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "week",
      startDate: "2026-10-15",
      endDate: "2026-10-18",
      settingsRevision: 0,
      expectedSnapshotId: null,
      requestSummary: "Новая подборка",
      items: [],
    },
    now,
  );
  expect(service.personal("belgrade", now)).toEqual([deleted]);
  expect(service.hidden("belgrade", now)).toEqual([]);
  service.updatePersonal(
    { scopeId: "belgrade", id: item.id, deleted: false },
    now,
  );
  const restored = service.personal("belgrade", now)[0];
  expect(restored.deletedAt).toBeNull();
  expect(recommendationSlots([restored], "Europe/Belgrade")[0].hour).toBe(19);
  expect(() =>
    service.updatePersonal(
      { scopeId: "serbia", id: item.id, deleted: true },
      now,
    ),
  ).toThrow(/не найдено/);
  expect(
    recommendationInputSchema.safeParse({
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "week",
      startDate: "2026-10-15",
      endDate: "2026-10-18",
      settingsRevision: 0,
      expectedSnapshotId: null,
      requestSummary: "Неделя",
      items: [item],
    }).success,
  ).toBe(false);
});
it("validates remaining-week dates, hours and stable create IDs without changing records on invalid input", () => {
  const service = new Recommendations(store),
    payload = input();
  for (const day of ["2026-10-14", "2026-10-19", "2026-02-30"]) {
    expect(() => service.addPersonal({ ...payload, day }, now)).toThrow();
  }
  for (const hour of [-1, 24, 12.5])
    expect(() => service.addPersonal({ ...payload, hour }, now)).toThrow();
  expect(() => service.addPersonal({ ...payload, title: " " }, now)).toThrow();
  expect(() =>
    service.addPersonal({ ...payload, group: "social" }, now),
  ).toThrow();
  service.addPersonal(payload, now);
  expect(() =>
    service.addPersonal({ ...payload, title: "Другой заголовок" }, now),
  ).toThrow(/ID/);
  expect(() =>
    service.addPersonal({ ...payload, scopeId: "serbia" }, now),
  ).toThrow(/ID/);
  expect(service.personal("belgrade", now)).toHaveLength(1);
});
it("retains deleted entries through Sunday and clears them at local Monday midnight, including DST", () => {
  const service = new Recommendations(store),
    payload = input();
  const item = service.addPersonal(
    { ...payload, day: "2026-10-15", hour: 0 },
    now,
  );
  service.updatePersonal(
    { scopeId: "belgrade", id: item.id, deleted: true },
    now,
  );
  expect(
    service.personal("belgrade", new Date("2026-10-18T21:59:59Z")),
  ).toHaveLength(1);
  expect(
    service.personal("belgrade", new Date("2026-10-18T22:00:00Z")),
  ).toEqual([]);
  expect(
    store.db.prepare("SELECT count(*) n FROM recommendation_personal").get()?.n,
  ).toBe(0);
  expect(() =>
    service.updatePersonal(
      { scopeId: "belgrade", id: item.id, deleted: false },
      new Date("2026-10-19T10:00:00Z"),
    ),
  ).toThrow(/завершилась/);
  service.addPersonal(
    { ...input(), day: "2026-10-25", hour: 19 },
    new Date("2026-10-23T10:00:00Z"),
  );
  expect(
    service.personal("belgrade", new Date("2026-10-25T22:59:59Z")),
  ).toHaveLength(1);
  expect(
    service.personal("belgrade", new Date("2026-10-25T23:00:00Z")),
  ).toEqual([]);
});

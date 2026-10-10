import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Store } from "../server/store.js";
import {
  autoArchivePastEvents,
  readAutoArchiveSettings,
  saveAutoArchiveSettings,
} from "../server/auto-archive.js";
import { SyncService } from "../server/sync.js";
import { getProvider } from "../server/providers/registry.js";
import type { EntityInput } from "../shared/model.js";

let store: Store;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  store = new Store(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  store.close();
});
const now = new Date("2026-10-02T12:00:00Z");
function add(title: string, fields: Partial<EntityInput> = {}) {
  store.ingest(store.source("source-manual"), [
    {
      entity: { type: "Event", title, startAt: "2000-01-01", ...fields },
      raw: { externalId: title, url: "", rawText: "", payload: {} },
    },
  ]);
  return store
    .entities({ includeFiltered: true })
    .find((e) => e.title === title)!;
}

it("is enabled by default, persists opt-out and rejects invalid settings without overwriting them", () => {
  expect(readAutoArchiveSettings(store)).toEqual({ enabled: true });
  saveAutoArchiveSettings(store, { enabled: false });
  expect(readAutoArchiveSettings(store)).toEqual({ enabled: false });
  expect(() => saveAutoArchiveSettings(store, { enabled: "false" })).toThrow();
  expect(() =>
    saveAutoArchiveSettings(store, { enabled: true, unknown: true }),
  ).toThrow();
  expect(readAutoArchiveSettings(store)).toEqual({ enabled: false });
  add("Past");
  expect(autoArchivePastEvents(store, undefined, now).archived).toBe(0);
  expect(store.entities({ includeFiltered: true })).toHaveLength(1);
  // The option never disables the explicit manual button.
  expect(store.archivePastEvents("belgrade", "2026-10-02").archived).toBe(1);
});

it("archives all scopes once, retains today's/ongoing/undated events and preserves personal state and provenance", () => {
  const past = add("Past");
  store.setState(past.id, {
    reaction: "dislike",
    favorite: true,
    dislikeReason: "Причина",
    notes: "Заметка",
  });
  add("Past in Novi Sad", { city: "Novi Sad" });
  add("Today", { startAt: "2026-10-02" });
  add("Ongoing", { startAt: "2026-10-01", endAt: "2026-10-03" });
  add("Undated", { startAt: "" });
  add("Future", { startAt: "2099-01-01" });
  expect(autoArchivePastEvents(store, undefined, now).archived).toBe(2);
  expect(autoArchivePastEvents(store, undefined, now).archived).toBe(0);
  expect(
    store
      .entities()
      .map((e) => e.title)
      .sort(),
  ).toEqual(["Future", "Ongoing", "Today", "Undated"]);
  const archived = store.db
    .prepare("SELECT snapshot FROM past_events_archive WHERE entityId=?")
    .get(past.id) as { snapshot: string };
  const snapshot = JSON.parse(archived.snapshot);
  expect(snapshot).toMatchObject({
    reaction: "dislike",
    favorite: true,
    dislikeReason: "Причина",
    notes: "Заметка",
  });
  expect(snapshot.provenance).toHaveLength(1);
});

it("uses each scope's local date and limits a source-triggered archive to that source's scope", () => {
  store.db
    .prepare("INSERT INTO scopes VALUES (?,?,?,?,?,?)")
    .run("utc", "UTC test", "DE", "Berlin", "UTC", null);
  add("Local past", { startAt: "2026-10-02" });
  add("UTC today", { country: "DE", city: "Berlin", startAt: "2026-10-02" });
  add("Other Serbian city", { city: "Novi Sad" });
  const midnight = new Date("2026-10-02T23:30:00Z");
  expect(autoArchivePastEvents(store, "belgrade", midnight).archived).toBe(1);
  expect(
    store.entities({ includeFiltered: true }).map((e) => e.title),
  ).toContain("Other Serbian city");
  expect(autoArchivePastEvents(store, undefined, midnight).archived).toBe(1);
  expect(store.entities().map((e) => e.title)).toEqual(["UTC today"]);
});

it("rolls back the whole multi-scope startup archive if any scope fails", () => {
  add("Past");
  const original = store.archivePastEvents.bind(store);
  let calls = 0;
  vi.spyOn(store, "archivePastEvents").mockImplementation((id, day) => {
    if (++calls === 2) throw new Error("Archive failure");
    return original(id, day);
  });
  expect(() => autoArchivePastEvents(store, undefined, now)).toThrow(
    "Archive failure",
  );
  expect(store.entities({ includeFiltered: true })).toHaveLength(1);
  expect(
    store.db.prepare("SELECT COUNT(*) AS count FROM past_events_archive").get()!
      .count,
  ).toBe(0);
});

it("archives before a real aggregator fetch and archives returned past events again after ingest", async () => {
  add("Existing past");
  const provider = getProvider("afisha");
  vi.spyOn(provider, "sync").mockImplementation(async () => {
    expect(store.entities({ includeFiltered: true })).toHaveLength(0);
    return {
      items: [{ externalId: "old", url: "", rawText: "", payload: {} }],
    };
  });
  vi.spyOn(provider, "normalize").mockReturnValue({
    type: "Event",
    title: "Imported past",
    startAt: "2000-01-01",
  });
  const result = await new SyncService(store).run("source-afisha");
  expect(store.entities({ includeFiltered: true })).toHaveLength(0);
  expect("warnings" in result && result.warnings).toContain(
    "Автоархив: 2 прошедших мероприятий.",
  );
  expect(
    store.db.prepare("SELECT COUNT(*) AS count FROM past_events_archive").get()!
      .count,
  ).toBe(2);
});

it("does not archive during connection tests, planning, non-aggregator sync or opted-out aggregator sync", async () => {
  add("Past");
  const aggregator = getProvider("afisha");
  vi.spyOn(aggregator, "testConnection").mockResolvedValue("OK");
  const sync = new SyncService(store);
  await sync.run("source-afisha", true);
  await sync.plan("source-afisha");
  expect(store.entities({ includeFiltered: true })).toHaveLength(1);
  const nonAggregator = getProvider("structured");
  vi.spyOn(nonAggregator, "sync").mockResolvedValue({ items: [] });
  store.saveSource({providerId: "structured", name: "Fixture", url: "https://venue.test/feed", enabled: true}, "source-structured");
  await sync.run("source-structured");
  expect(store.entities({ includeFiltered: true })).toHaveLength(1);
  saveAutoArchiveSettings(store, { enabled: false });
  vi.spyOn(aggregator, "sync").mockResolvedValue({ items: [] });
  await sync.run("source-afisha");
  expect(store.entities({ includeFiltered: true })).toHaveLength(1);
});

it("does not fetch when archiving fails and clears the sync lock for a subsequent source", async () => {
  const archive = vi
    .spyOn(store, "archivePastEvents")
    .mockImplementation(() => {
      throw new Error("Archive failure");
    });
  const provider = getProvider("afisha");
  const fetch = vi.spyOn(provider, "sync").mockResolvedValue({ items: [] });
  const sync = new SyncService(store);
  await expect(sync.run("source-afisha")).rejects.toThrow("Archive failure");
  expect(fetch).not.toHaveBeenCalled();
  archive.mockRestore();
  vi.spyOn(getProvider("tickets"), "sync").mockResolvedValue({ items: [] });
  await expect(sync.run("source-tickets")).resolves.toMatchObject({
    errors: 0,
  });
});

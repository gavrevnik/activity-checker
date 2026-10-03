import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEntityPresentation,
  presentationVersion,
} from "../server/entity-presentation";
import { Store } from "../server/store";
import { entitySchema, type EntityInput } from "../shared/model";

const opened: Store[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});
function open(path = ":memory:") {
  const store = new Store(path);
  opened.push(store);
  return store;
}
function ingest(store: Store, value: EntityInput, externalId = "event") {
  store.ingest(store.source("source-manual"), [
    {
      entity: value,
      raw: { externalId, url: "", rawText: "", payload: value },
    },
  ]);
  return store
    .entities({ includeFiltered: true })
    .find((item) => item.title === value.title)!;
}
describe("persisted static card presentation", () => {
  it("prepares local calendar days, weekdays, start hours and search flags", () => {
    const entity = entitySchema.parse({
      type: "Event",
      title: "Čaj Concert",
      startAt: "2026-09-30T23:30:00Z",
      endAt: "2026-10-02T22:00:00Z",
      description: "Live MUSIC",
      venue: "Hall",
      tags: ["jazz"],
    });
    expect(buildEntityPresentation(entity)).toMatchObject({
      version: presentationVersion,
      timeZone: "Europe/Belgrade",
      startDay: "2026-10-01",
      endDay: "2026-10-03",
      startHour: 1,
      dateLabel: "2026-10-01 · Чт · 01:30 - 2026-10-03 · Сб · 00:00",
      dayNumber: "01",
      searchText: "čaj concert live music  hall  jazz",
      hasSerbianTitle: true,
    });
    expect(buildEntityPresentation(entity, "UTC")).toMatchObject({
      startDay: "2026-09-30",
      startHour: 23,
      dayNumber: "30",
    });
  });
  it("never invents a time for date-only or undated cards", () => {
    const dateOnly = buildEntityPresentation(
      entitySchema.parse({
        type: "Event",
        title: "Date only",
        startAt: "2026-10-02",
      }),
      "Pacific/Kiritimati",
    );
    expect(dateOnly).toMatchObject({
      startDay: "2026-10-02",
      endDay: "2026-10-02",
      dayNumber: "02",
      monthLabel: "окт.",
      startHour: null,
      dateLabel: "2026-10-02 · Пт",
    });
    const undated = buildEntityPresentation(
      entitySchema.parse({ type: "Event", title: "Unknown" }),
    );
    expect(undated).toMatchObject({
      startDay: "",
      endDay: "",
      startHour: null,
      dateLabel: "",
    });
    expect(undated).not.toHaveProperty("isPast");
  });
  it("refreshes cached start-only labels without changing canonical data or personal state", () => {
    const store = open();
    const original = ingest(store, {
      type: "Event",
      title: "Long event",
      startAt: "2099-10-02",
      endAt: "2099-10-04",
    });
    const saved = store.setState(original.id, {
      favorite: true,
      reaction: "like",
      notes: "Keep this note",
    });
    const before = store.db
      .prepare("SELECT data,createdAt,updatedAt FROM entities WHERE id=?")
      .get(original.id);
    store.db
      .prepare("UPDATE entities SET presentation=? WHERE id=?")
      .run(
        JSON.stringify({
          ...saved.presentation,
          version: 1,
          dateLabel: "Old start-only label",
        }),
        original.id,
      );
    const updated = store.entitySummary(original.id);
    expect(updated).toMatchObject({
      favorite: true,
      reaction: "like",
      notes: "Keep this note",
      presentation: {
        version: presentationVersion,
        dateLabel: "2099-10-02 · Пт - 2099-10-04 · Вс",
      },
    });
    expect(
      store.db
        .prepare("SELECT data,createdAt,updatedAt FROM entities WHERE id=?")
        .get(original.id),
    ).toEqual(before);
    expect(
      JSON.parse(
        String(
          store.db
            .prepare("SELECT presentation FROM entities WHERE id=?")
            .get(original.id)!.presentation,
        ),
      ).version,
    ).toBe(presentationVersion);
  });
  it("recomputes static values after ingestion, canonical edits and direct AI updates", () => {
    const store = open();
    const original = ingest(store, {
      type: "Event",
      title: "First",
      startAt: "2099-10-02",
    });
    expect(
      JSON.parse(
        String(
          store.db
            .prepare("SELECT presentation FROM entities WHERE id=?")
            .get(original.id)!.presentation,
        ),
      ),
    ).toEqual(original.presentation);
    store.setState(original.id, { favorite: true, reaction: "like" });
    const input = entitySchema.parse(
      Object.fromEntries(
        Object.keys(entitySchema.shape).map((key) => [
          key,
          (original as any)[key],
        ]),
      ),
    );
    store.editEntity(original.id, {
      ...input,
      title: "Changed",
      startAt: "2099-11-03",
    });
    expect(store.entitySummary(original.id)).toMatchObject({
      favorite: true,
      reaction: "like",
      presentation: {
        startDay: "2099-11-03",
        dayNumber: "03",
        searchText: "changed    ",
      },
    });
    store.db
      .prepare(
        "UPDATE entities SET data=json_set(data,'$.title','Direct title') WHERE id=?",
      )
      .run(original.id);
    expect(
      store.db
        .prepare("SELECT presentation FROM entities WHERE id=?")
        .get(original.id)!.presentation,
    ).toBe("{}");
    expect(store.entitySummary(original.id).presentation.searchText).toContain(
      "direct title",
    );
    store.db
      .prepare("UPDATE scopes SET timezone='UTC' WHERE id='belgrade'")
      .run();
    expect(store.entitySummary(original.id).presentation.timeZone).toBe("UTC");
  });
  it("backfills existing cards at startup without changing user state or timestamps", () => {
    const directory = mkdtempSync(join(tmpdir(), "activity-presentation-"));
    try {
      const path = join(directory, "test.sqlite"),
        first = new Store(path);
      const entity = ingest(first, {
        type: "Event",
        title: "Existing",
        startAt: "2099-10-02",
      });
      const saved = first.setState(entity.id, {
        favorite: true,
        reaction: "dislike",
        notes: "Keep",
      });
      first.db
        .prepare("UPDATE entities SET presentation='{}' WHERE id=?")
        .run(entity.id);
      first.close();
      const second = new Store(path);
      try {
        const result = second.entitySummary(entity.id);
        expect(result).toMatchObject({
          favorite: true,
          reaction: "dislike",
          notes: "Keep",
          updatedAt: saved.updatedAt,
          presentation: {
            version: presentationVersion,
            startDay: "2099-10-02",
          },
        });
        expect(
          second.db
            .prepare("SELECT presentation FROM entities WHERE id=?")
            .get(entity.id)!.presentation,
        ).not.toBe("{}");
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("updates personal state without reading unrelated cards or raw provenance", () => {
    const store = open();
    const target = ingest(
      store,
      { type: "Event", title: "Target", startAt: "2099-10-02" },
      "target",
    );
    const unrelated = ingest(
      store,
      { type: "Place", title: "Unrelated" },
      "other",
    );
    // A corrupt unrelated import must not make all rating buttons fail.
    store.db
      .prepare("UPDATE entities SET data='{}' WHERE id=?")
      .run(unrelated.id);
    const result = store.setState(target.id, { reaction: "like" });
    expect(result).toMatchObject({
      reaction: "like",
      sources: [{ id: "source-manual" }],
    });
    expect(result).not.toHaveProperty("provenance");
    expect(store.entity(target.id).provenance).toHaveLength(1);
    store.setState(target.id, { favorite: true });
    expect(store.entitySummary(target.id)).toMatchObject({
      favorite: true,
      reaction: "like",
    });
  });
});

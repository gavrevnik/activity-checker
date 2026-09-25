import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store";
import { importEntities } from "../server/import";
import { entitySchema, type EntityInput } from "../shared/model";
import { seedDemo } from "../server/demo";
let store: Store;
beforeEach(() => (store = new Store(":memory:")));
afterEach(() => store.close());
const place: EntityInput = {
  type: "Place",
  title: "Boulder Room",
  address: "Test 12",
  city: "Belgrade",
  url: "https://venue.test/location",
  description: "Original",
};
function ingest(
  value: EntityInput,
  externalId = "1",
  sourceId = "source-manual",
) {
  return store.ingest(store.source(sourceId), [
    {
      entity: value,
      raw: {
        externalId,
        url: value.url || "",
        rawText: value.description || "",
        payload: value,
      },
    },
  ]);
}
function input(id: string) {
  const e = store.entity(id);
  return entitySchema.parse(
    Object.fromEntries(
      Object.keys(entitySchema.shape).map((k) => [k, (e as any)[k]]),
    ),
  );
}
describe("canonical ingestion", () => {
  it("seeds sources without secrets or invented connection success", () => {
    expect(store.scopes()).toHaveLength(2);
    expect(store.sources().length).toBeGreaterThan(15);
    expect(store.sources().every((s) => s.status !== "connected")).toBe(true);
  });
  it("is idempotent and keeps original payload", () => {
    expect(ingest(place).created).toBe(1);
    expect(ingest(place).duplicates).toBe(1);
    expect(store.entities()).toHaveLength(1);
    const e = store.entity(store.entities()[0].id);
    expect(e.provenance).toHaveLength(1);
    expect(e.provenance[0].rawPayload).toEqual(place);
  });
  it("keeps changed raw versions and edits, personal state and AI metadata", () => {
    ingest(place);
    const id = store.entities()[0].id;
    store.editEntity(id, {
      ...input(id),
      title: "My title",
      aiScore: 91,
      aiDecision: "recommended",
    });
    store.setState(id, { favorite: true, archived: true, notes: "Try this" });
    expect(
      ingest({ ...place, title: "Provider title", description: "New details" })
        .updated,
    ).toBe(1);
    const e = store.entity(id);
    expect(e.title).toBe("My title");
    expect(e.description).toBe("New details");
    expect(e.aiScore).toBe(91);
    expect(e.favorite && e.archived).toBe(true);
    expect(e.notes).toBe("Try this");
    expect(e.provenance).toHaveLength(2);
  });
  it("deduplicates across sources and links both", () => {
    ingest(place);
    ingest(
      { ...place, url: "https://venue.test/location?utm_source=tg" },
      "channel-2",
      "source-telegram",
    );
    expect(store.entities()).toHaveLength(1);
    expect(store.entities()[0].sources).toHaveLength(2);
    expect(store.entity(store.entities()[0].id).provenance).toHaveLength(2);
  });
  it("does not merge types, countries, or different event dates", () => {
    const e: EntityInput = {
      type: "Event",
      title: "Jazz",
      url: "https://club.test/events/jazz",
      venue: "Club",
      startAt: "2026-10-01T20:00:00+02:00",
    };
    ingest(e, "1");
    ingest({ ...e, startAt: "2026-10-02T20:00:00+02:00" }, "2");
    ingest({ ...e, type: "Place" }, "3");
    ingest({ ...e, country: "DE" }, "4");
    expect(store.entities()).toHaveLength(4);
  });
  it("uses complete event signatures across timezones", () => {
    const e: EntityInput = {
      type: "Event",
      title: "Jazz",
      venue: "Club",
      startAt: "2026-10-01T20:00:00+02:00",
    };
    ingest(e, "1");
    ingest({ ...e, startAt: "2026-10-01T18:00:00Z" }, "2");
    expect(store.entities()).toHaveLength(1);
  });
  it("flags ambiguous names without destructive merge", () => {
    ingest({ type: "Community", title: "Photo club" }, "1");
    ingest({ type: "Community", title: "Photo club" }, "2");
    expect(store.entities()).toHaveLength(2);
    expect(store.entities().every((e) => e.duplicateCount === 1)).toBe(true);
  });
  it("does not equate guid 1 from unrelated RSS sources", () => {
    const a = store.saveSource({
      providerId: "structured",
      name: "A",
      url: "https://a.test/rss",
    });
    const b = store.saveSource({
      providerId: "structured",
      name: "B",
      url: "https://b.test/rss",
    });
    ingest({ type: "Event", title: "A" }, "1", a.id);
    ingest({ type: "Event", title: "B" }, "1", b.id);
    expect(store.entities()).toHaveLength(2);
  });
  it("preview rolls back entities, provenance and discovery", () => {
    const e = { ...place, website: "https://t.me/exampleclub" };
    const preview = importEntities(store, { entities: [e] }, true);
    expect(preview.result.created).toBe(1);
    expect(store.entities()).toHaveLength(0);
    expect(store.candidates()).toHaveLength(0);
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM source_items").get()?.n,
    ).toBe(0);
  });
  it("rejects an entire invalid batch before writing", () => {
    expect(() =>
      importEntities(store, {
        entities: [place, { type: "Bad", title: "bad" }],
      }),
    ).toThrow();
    expect(store.entities()).toHaveLength(0);
  });
  it("rolls back a partially processed provider batch", () => {
    expect(() =>
      store.ingest(
        store.source("source-manual"),
        [place, { ...place, title: "" }].map((entity, i) => ({
          entity,
          raw: { externalId: String(i), url: "", rawText: "", payload: entity },
        })),
      ),
    ).toThrow();
    expect(store.entities()).toHaveLength(0);
  });
  it("accepts fenced JSON with conservative defaults", () => {
    expect(
      importEntities(store, '```json\n[{"type":"Place","title":"A"}]\n```')
        .result.created,
    ).toBe(1);
    expect(store.entities()[0].country).toBe("RS");
  });
  it("discovers social source then accepts it disabled once", () => {
    ingest({ ...place, description: "Visit https://t.me/exampleclub" });
    const c = store.candidates()[0];
    expect(c.probableType).toBe("telegram");
    const source = store.candidateAction(c.id, "accept");
    expect(source?.enabled).toBe(false);
    expect(() => store.candidateAction(c.id, "accept")).toThrow();
  });
  it("merges provenance and relationships without losing edits", () => {
    ingest({ type: "Community", title: "A" }, "a");
    const a = store.entities()[0].id;
    ingest({ type: "Community", title: "B" }, "b");
    const b = store.entities().find((e) => e.title === "B")!.id;
    ingest({ type: "Event", title: "E" }, "e");
    const e = store.entities().find((e) => e.title === "E")!.id;
    store.relate(b, e, "organizes");
    store.setState(b, { notes: "From B", favorite: true });
    store.merge(a, b);
    expect(store.entities()).toHaveLength(2);
    const kept = store.entity(a);
    expect(kept.provenance).toHaveLength(2);
    expect(kept.related[0].id).toBe(e);
    expect(kept.notes).toBe("From B");
    expect(kept.favorite).toBe(true);
    ingest({ type: "Community", title: "B" }, "b");
    expect(store.entities()).toHaveLength(2);
  });
  it("separates demo from real and does not reseed after removal", () => {
    seedDemo(store);
    expect(store.entities()).toHaveLength(4);
    store.deleteDemo();
    seedDemo(store);
    expect(store.entities()).toHaveLength(0);
  });
  it("rejects secrets in source URL and provider mutation", () => {
    expect(() =>
      store.saveSource({
        providerId: "structured",
        name: "secret",
        url: "https://example.test?token=secret",
      }),
    ).toThrow();
    expect(() =>
      store.saveSource(
        { providerId: "telegram", name: "changed" },
        "source-overpass",
      ),
    ).toThrow();
  });
});
it("does not oscillate between unchanged provider records for one canonical place", () => {
  ingest(place, "node/1");
  ingest({ ...place, description: "Way data" }, "way/2");
  expect(ingest(place, "node/1").duplicates).toBe(1);
  expect(
    ingest({ ...place, description: "Way data" }, "way/2").duplicates,
  ).toBe(1);
  expect(store.entities()).toHaveLength(1);
});
it("applies a provider reverting to a previously seen raw version", () => {
  ingest(place);
  ingest({ ...place, description: "Second" });
  ingest(place);
  expect(store.entities()[0].description).toBe("Original");
  expect(store.entity(store.entities()[0].id).provenance).toHaveLength(2);
});
it("separates identical external IDs across countries", () => {
  ingest(place);
  ingest({ ...place, country: "DE" });
  expect(store.entities()).toHaveLength(2);
});
it("reprocesses identical raw data when adapter normalization changes", () => {
  const raw = {
    externalId: "fixed",
    url: "",
    rawText: "",
    payload: { name: "Gym" },
  };
  const source = store.source("source-manual");
  store.ingest(source, [
    { raw, entity: { type: "Place", title: "Gym", category: "Другое" } },
  ]);
  expect(
    store.ingest(source, [
      { raw, entity: { type: "Place", title: "Gym", category: "Спорт" } },
    ]).updated,
  ).toBe(1);
  expect(store.entities()[0].category).toBe("Спорт");
  expect(store.entity(store.entities()[0].id).provenance).toHaveLength(1);
});

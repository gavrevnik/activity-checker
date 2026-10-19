import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Store } from "../server/store.js";

it("offers only city flows and rejects new sources in the retired country flow", () => {
  const store = new Store(":memory:");
  try {
    expect(store.scopes().map((scope) => scope.id)).toEqual([
      "belgrade",
      "chisinau",
    ]);
    expect(store.source("source-serbia-travel").scopeId).toBe("belgrade");
    expect(() =>
      store.saveSource({
        providerId: "manual",
        name: "Retired flow",
        scopeId: "serbia",
      }),
    ).toThrow("Белграду или Кишинёву");
  } finally {
    store.close();
  }
});

it("moves legacy source configuration without changing stored events or provenance", () => {
  const store = new Store(":memory:");
  try {
    const source = store.source("source-serbia-travel");
    store.ingest(source, [
      {
        entity: {
          type: "Event",
          title: "Preserved event",
          country: "RS",
          city: "Niš",
          startAt: "2099-10-20",
        },
        raw: {
          externalId: "preserved",
          url: "https://www.serbia.travel/en/events/preserved",
          rawText: "Preserved source text",
          payload: { original: "preserved" },
        },
      },
    ]);
    store.db
      .prepare(
        "UPDATE sources SET scopeId='serbia',notes='User note',enabled=1 WHERE id=?",
      )
      .run(source.id);
    const entities = store.db.prepare("SELECT * FROM entities").all();
    const raw = store.db.prepare("SELECT * FROM source_items").all();
    const links = store.db.prepare("SELECT * FROM entity_source_links").all();
    const migration = readFileSync(
      new URL("../migrations/041_retire_serbia_flow.sql", import.meta.url),
      "utf8",
    );
    store.db.exec(migration);
    store.db.exec(migration);
    expect(store.source(source.id)).toMatchObject({
      scopeId: "belgrade",
      notes: "User note",
      enabled: true,
    });
    expect(store.db.prepare("SELECT * FROM entities").all()).toEqual(entities);
    expect(store.db.prepare("SELECT * FROM source_items").all()).toEqual(raw);
    expect(store.db.prepare("SELECT * FROM entity_source_links").all()).toEqual(
      links,
    );
    expect(store.scope("serbia")).toMatchObject({ country: "RS", city: null });
  } finally {
    store.close();
  }
});

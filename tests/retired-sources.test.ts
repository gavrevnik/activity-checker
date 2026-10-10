import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Store } from "../server/store.js";
import { getProvider } from "../server/providers/registry.js";
const store = new Store(":memory:");
afterEach(() => store.close());
it("removes retired provenance and exclusive cards, preserves shared cards and archives, and never reseeds", () => {
  for (const providerId of ["bilet", "overpass"]) {
    store.db
      .prepare(
        "INSERT INTO sources(id,providerId,name,scopeId) VALUES(?,?,?,?)",
      )
      .run(`source-${providerId}`, providerId, providerId, "belgrade");
    expect(() => getProvider(providerId)).toThrow();
    expect(() => store.saveSource({ providerId, name: providerId })).toThrow();
  }
  const ingest = (id: string, title: string) =>
    store.ingest(store.source(id), [
      {
        entity: { type: "Event", title, startAt: "2099-01-01" },
        raw: { externalId: title, url: "", rawText: "", payload: {} },
      },
    ]);
  ingest("source-bilet", "Exclusive");
  ingest("source-bilet", "Shared");
  ingest("source-manual", "Shared");
  const shared = store
    .entities({ includeFiltered: true })
    .find((e) => e.title === "Shared")!;
  store.setState(shared.id, { notes: "Keep note", favorite: true });
  const item = store.db
    .prepare("SELECT id FROM source_items WHERE sourceId='source-bilet'")
    .get()!;
  store.db
    .prepare(
      "INSERT INTO source_candidates(id,name,url,discoveredFrom,scopeId,probableType,reason) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "candidate",
      "candidate",
      "https://bilet.rs/events/1",
      item.id,
      "belgrade",
      "Event",
      "fixture",
    );
  store.db
    .prepare(
      "INSERT INTO sync_runs(id,sourceId,startedAt,status) VALUES(?,?,?,?)",
    )
    .run("attempt", "source-bilet", "2026-10-10", "success");
  for (const [id, provenance] of [
    ["exclusive-archive", [{ sourceId: "source-bilet", providerId: "bilet" }]],
    [
      "shared-archive",
      [
        { sourceId: "source-bilet", providerId: "bilet" },
        { sourceId: "source-manual", providerId: "manual" },
      ],
    ],
  ] as const) {
    store.db
      .prepare(
        "INSERT INTO past_events_archive(entityId,title,country,city,startAt,snapshot,archivedAt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        id,
        "RS",
        "Belgrade",
        "2000-01-01",
        JSON.stringify({ provenance, notes: "Keep archive note" }),
        "2026-10-10",
      );
  }
  const sql = readFileSync(
    new URL(
      "../migrations/032_remove_retired_activity_sources.sql",
      import.meta.url,
    ),
    "utf8",
  );
  store.transaction(() => store.db.exec(sql));
  expect(store.entities({ includeFiltered: true }).map((e) => e.title)).toEqual(
    ["Shared"],
  );
  expect(store.entity(shared.id)).toMatchObject({
    notes: "Keep note",
    favorite: true,
  });
  expect(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM sources WHERE providerId IN ('bilet','overpass')",
      )
      .get()!.n,
  ).toBe(0);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM source_candidates").get()!.n,
  ).toBe(0);
  expect(store.db.prepare("SELECT count(*) AS n FROM sync_runs").get()!.n).toBe(
    0,
  );
  expect(
    store.db
      .prepare(
        "SELECT snapshot FROM past_events_archive WHERE entityId='exclusive-archive'",
      )
      .get(),
  ).toBeUndefined();
  const archive = JSON.parse(
    store.db
      .prepare(
        "SELECT snapshot FROM past_events_archive WHERE entityId='shared-archive'",
      )
      .get()!.snapshot as string,
  );
  expect(archive).toEqual({
    notes: "Keep archive note",
    provenance: [{ sourceId: "source-manual", providerId: "manual" }],
  });
  expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  store.transaction(() => store.db.exec(sql));
  store.seed();
  expect(store.sources().map((s) => s.providerId)).not.toContain("bilet");
  expect(store.sources().map((s) => s.providerId)).not.toContain("overpass");
});

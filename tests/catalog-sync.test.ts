import { expect, it } from "vitest";
import { Store } from "../server/store";
import {
  catalogLinks,
  catalogStatus,
  setCatalogInterest,
} from "../../personal-radar/catalog_sync/node";
it("stores explicit source interest atomically without changing event reactions or monitoring", () => {
  const store = new Store(":memory:");
  try {
    const canonical = {
      id: "telegram-fixture",
      name: "Fixture",
      status: { interest: "medium" },
    };
    store.db
      .prepare("INSERT INTO catalog_entity_links VALUES (?,?,?,?,?,?,?,?)")
      .run(
        "entities",
        "fixture",
        "source",
        "telegram-fixture",
        "a".repeat(40),
        new Date().toISOString(),
        JSON.stringify(canonical),
        "{}",
      );
    setCatalogInterest(store.db, "entities", "fixture", "high");
    setCatalogInterest(store.db, "entities", "fixture", "low");
    expect(catalogStatus(store.db).outbox.pending).toBe(1);
    expect(catalogLinks(store.db)[0].pending[0].value).toBe("low");
    expect(() =>
      setCatalogInterest(store.db, "entities", "fixture", "invalid"),
    ).toThrow();
    expect(
      store.db.prepare("SELECT count(*) n FROM catalog_outbox").get()?.n,
    ).toBe(1);
    expect(catalogLinks(store.db)[0].canonical.status.interest).toBe("medium");
    expect(store.entities()).toHaveLength(0);
  } finally {
    store.close();
  }
});
it("profile preference changes create an outbox only for an existing canonical preference", () => {
  const store = new Store(":memory:");
  try {
    const { updatedAt: _updatedAt, ...profile } = store.profile();
    store.saveProfile({ ...profile, musicPreferences: ["Jazz"] });
    expect(catalogStatus(store.db).outbox.pending || 0).toBe(0);
    store.db
      .prepare("INSERT INTO catalog_entity_links VALUES (?,?,?,?,?,?,?,?)")
      .run(
        "user_profile",
        "main:music",
        "preference",
        "music-preferences",
        "a".repeat(40),
        new Date().toISOString(),
        JSON.stringify({
          id: "music-preferences",
          domain: "music",
          statements: ["Jazz"],
        }),
        "{}",
      );
    store.saveProfile({ ...profile, musicPreferences: ["Soul"] });
    expect(catalogStatus(store.db).outbox.pending).toBe(1);
    expect(store.profile().musicPreferences).toEqual(["Soul"]);
  } finally {
    store.close();
  }
});

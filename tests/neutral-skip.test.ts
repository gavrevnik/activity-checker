import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.js";

it("migrates and reopens skip state without losing reactions, favorites, reasons or source links", () => {
  const directory = mkdtempSync(join(tmpdir(), "activity-neutral-skip-"));
  const path = join(directory, "test.sqlite");
  let store: Store | undefined;
  try {
    store = new Store(path);
    const add = (title: string, date: string) => {
      store!.ingest(store!.source("source-manual"), [
        {
          entity: { type: "Event", title, startAt: date },
          raw: { externalId: title, url: "", rawText: "", payload: {} },
        },
      ]);
      return store!.entities().find((event) => event.title === title)!.id;
    };
    const id = add("Neutral skip", "2099-10-01");
    const likedId = add("Keep rating", "2099-10-02");
    store.setState(id, { skipped: true, skipReason: "дубль" });
    store.setState(likedId, {
      reaction: "like",
      favorite: true,
      dislikeReason: "historical",
    });
    store.close();
    store = new Store(path);
    expect(store.entity(id)).toMatchObject({
      skipped: true,
      skipReason: "дубль",
      reaction: "",
      favorite: false,
    });
    expect(store.entity(likedId)).toMatchObject({
      skipped: false,
      skipReason: "",
      reaction: "like",
      favorite: true,
      dislikeReason: "historical",
    });
    expect(store.entity(id).sources).toHaveLength(1);
    store.setState(id, { skipped: false });
    expect(store.entity(id)).toMatchObject({
      skipped: false,
      reaction: "",
      skipReason: "дубль",
    });
    store.setState(id, { skipped: true });
    store.merge(likedId, id);
    expect(store.entity(likedId)).toMatchObject({
      reaction: "like",
      skipped: false,
      favorite: true,
    });
    store.ingest(store.source("source-manual"), [
      {
        entity: { type: "Community", title: "Not an event" },
        raw: { externalId: "club", url: "", rawText: "", payload: {} },
      },
    ]);
    const community = store
      .entities()
      .find((entity) => entity.type === "Community")!;
    expect(() => store!.setState(community.id, { skipped: true })).toThrow(
      "Оценивать можно только мероприятия",
    );
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

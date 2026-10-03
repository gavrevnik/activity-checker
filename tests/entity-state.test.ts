import { describe, expect, it, vi } from "vitest";
import {
  createEntityStateUpdater,
  type EntityStatePatch,
} from "../src/entity-state";
import { entitySchema, type Entity } from "../shared/model";
import { buildEntityPresentation } from "../server/entity-presentation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function card(id: string): Entity {
  const data = entitySchema.parse({ type: "Event", title: id });
  return {
    ...data,
    presentation: buildEntityPresentation(data),
    id,
    archived: false,
    favorite: false,
    reaction: "",
    dislikeReason: "",
    skipped: false,
    skipReason: "",
    notes: "",
    filtered: false,
    filterReasons: [],
    createdAt: "initial",
    updatedAt: "initial",
    sources: [],
    duplicateCount: 0,
  };
}
function harness() {
  const cards = new Map(["a", "b"].map((id) => [id, card(id)]));
  const requests = new Map<string, ReturnType<typeof deferred<Entity>>>();
  const pending = new Set<string>();
  const reportError = vi.fn();
  const save = vi.fn((id: string, _state: EntityStatePatch) => {
    const request = deferred<Entity>();
    requests.set(id, request);
    return request.promise;
  });
  const update = createEntityStateUpdater({
    save,
    reportError,
    patch: (id, state) => cards.set(id, { ...cards.get(id)!, ...state }),
    pending: (id, value) => {
      if (value) pending.add(id);
      else pending.delete(id);
    },
  });
  return { cards, requests, pending, reportError, save, update };
}
describe("independent optimistic card actions", () => {
  it("optimistically replaces a reaction with a neutral skip and restores both on failure", async () => {
    const h = harness();
    h.cards.set("a", { ...h.cards.get("a")!, reaction: "like" });
    const saving = h.update(h.cards.get("a")!, { skipped: true });
    await vi.waitFor(() =>
      expect(h.cards.get("a")).toMatchObject({ skipped: true, reaction: "" }),
    );
    expect(h.save).toHaveBeenCalledWith("a", { skipped: true, reaction: "" });
    h.requests.get("a")!.reject(new Error("Failed skip"));
    expect(await saving).toBe(false);
    expect(h.cards.get("a")).toMatchObject({
      skipped: false,
      reaction: "like",
    });
    const retry = h.update(h.cards.get("a")!, {
      skipped: true,
      skipReason: "дубль",
    });
    h.requests
      .get("a")!
      .resolve({
        ...h.cards.get("a")!,
        skipped: true,
        reaction: "",
        skipReason: "дубль",
      });
    expect(await retry).toBe(true);
    expect(h.cards.get("a")).toMatchObject({
      skipped: true,
      reaction: "",
      skipReason: "дубль",
    });
  });
  it("confirms feedback and rolls back only the reason on a failed write", async () => {
    const h = harness();
    h.cards.set("a", {
      ...h.cards.get("a")!,
      reaction: "dislike",
      dislikeReason: "Old reason",
    });
    const saving = h.update(h.cards.get("a")!, { dislikeReason: "New reason" });
    await vi.waitFor(() =>
      expect(h.cards.get("a")!.dislikeReason).toBe("New reason"),
    );
    h.requests.get("a")!.reject(new Error("Failed feedback"));
    expect(await saving).toBe(false);
    expect(h.cards.get("a")).toMatchObject({
      reaction: "dislike",
      dislikeReason: "Old reason",
    });
    const retry = h.update(h.cards.get("a")!, { dislikeReason: "Retry" });
    h.requests
      .get("a")!
      .resolve({ ...h.cards.get("a")!, dislikeReason: "Retry" });
    expect(await retry).toBe(true);
  });
  it("finishes the local exit without waiting for SQLite or HTTP", async () => {
    const h = harness(),
      animation = deferred<void>();
    const saving = h.update(
      h.cards.get("a")!,
      { reaction: "like" },
      () => animation.promise,
    );
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.pending.has("a")).toBe(true);
    expect(h.cards.get("a")!.reaction).toBe("");
    animation.resolve();
    await vi.waitFor(() => expect(h.cards.get("a")!.reaction).toBe("like"));
    expect(h.pending.has("a")).toBe(true);
    h.requests.get("a")!.resolve({ ...h.cards.get("a")!, updatedAt: "saved" });
    await saving;
    expect(h.pending.size).toBe(0);
    expect(h.cards.get("a")!.updatedAt).toBe("saved");
  });
  it("saves different cards concurrently and guards double clicks on one card", async () => {
    const h = harness();
    const first = h.update(h.cards.get("a")!, { reaction: "like" });
    await h.update(h.cards.get("a")!, { reaction: "dislike" });
    const second = h.update(h.cards.get("b")!, { reaction: "dislike" });
    await vi.waitFor(() => expect(h.cards.get("b")!.reaction).toBe("dislike"));
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.pending.size).toBe(2);
    h.requests.get("b")!.resolve(h.cards.get("b")!);
    await second;
    expect(h.pending.has("a")).toBe(true);
    expect(h.pending.has("b")).toBe(false);
    h.requests.get("a")!.resolve(h.cards.get("a")!);
    await first;
  });
  it("rolls back only the failed field without losing other card changes", async () => {
    const h = harness();
    const first = h.update(h.cards.get("a")!, { reaction: "like" });
    const second = h.update(h.cards.get("b")!, { favorite: true });
    await vi.waitFor(() => expect(h.cards.get("a")!.reaction).toBe("like"));
    h.cards.set("a", {
      ...h.cards.get("a")!,
      favorite: true,
      title: "New title",
    });
    h.requests.get("a")!.reject(new Error("offline"));
    h.requests.get("b")!.resolve(h.cards.get("b")!);
    await Promise.all([first, second]);
    expect(h.cards.get("a")).toMatchObject({
      reaction: "",
      favorite: true,
      title: "New title",
    });
    expect(h.cards.get("b")!.favorite).toBe(true);
    expect(h.pending.size).toBe(0);
    expect(h.reportError).toHaveBeenCalledOnce();
    const retry = h.update(h.cards.get("a")!, { reaction: "dislike" });
    h.requests.get("a")!.resolve({ ...h.cards.get("a")!, reaction: "dislike" });
    await retry;
    expect(h.cards.get("a")!.reaction).toBe("dislike");
  });
  it("handles rejection even while the exit animation is still running", async () => {
    const h = harness(),
      animation = deferred<void>();
    const saving = h.update(
      h.cards.get("a")!,
      { favorite: true },
      () => animation.promise,
    );
    h.requests.get("a")!.reject(new Error("failed immediately"));
    await Promise.resolve();
    animation.resolve();
    await saving;
    expect(h.cards.get("a")!.favorite).toBe(false);
    expect(h.reportError).toHaveBeenCalledOnce();
    expect(h.pending.size).toBe(0);
  });
});

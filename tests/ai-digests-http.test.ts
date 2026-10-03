import express from "express";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";

it("round-trips digest API, schema, retries, archive and validation on an isolated DB", async () => {
  const store = new Store(":memory:"),
    app = express(),
    server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    app.use(createApi(store, address.port));
    const base = `http://127.0.0.1:${address.port}/api`;
    const input = {
      id: randomUUID(),
      scopeId: "belgrade",
      title: "Один день",
      requestSummary: "Подборка на день",
      startDate: "2099-10-10",
      endDate: "2099-10-10",
      items: [],
    };
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await fetch(base + "/ai-digests/schema")).status).toBe(200);
    const first = await (await post("/ai-digests", input)).json();
    expect(first.archivedAt).toBeNull();
    expect(await (await post("/ai-digests", input)).json()).toEqual(first);
    expect(
      (await post("/ai-digests", { ...input, title: "Changed" })).status,
    ).toBe(400);
    expect(
      await (await fetch(base + "/ai-digests/" + input.id)).json(),
    ).toEqual(first);
    expect(
      (await (await fetch(base + "/ai-digests?scopeId=belgrade")).json())
        .digests,
    ).toHaveLength(1);
    expect(
      (await fetch(base + "/ai-digests?scopeId=belgrade&archived=no")).status,
    ).toBe(400);
    expect((await fetch(base + "/ai-digests/missing")).status).toBe(404);
    const patch = (id: string, body: unknown) =>
      fetch(base + `/ai-digests/${id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await patch(input.id, { expectedItems: [], tags: [] })).status,
    ).toBe(200);
    expect(
      (await patch(input.id, { expectedItems: [], tags: [["туризм"]] })).status,
    ).toBe(400);
    expect(
      (await patch("missing", { expectedItems: [], tags: [] })).status,
    ).toBe(404);
    expect(
      (
        await post("/ai-digests", {
          ...input,
          id: randomUUID(),
          endDate: "2000-01-01",
        })
      ).status,
    ).toBe(400);
    const archived = await (
      await post("/ai-digests", {
        ...input,
        id: randomUUID(),
        startDate: "2000-01-01",
        endDate: "2000-01-01",
      })
    ).json();
    expect(archived.archivedAt).toBeTruthy();
    expect(
      (
        await (
          await fetch(base + "/ai-digests?scopeId=serbia&archived=true")
        ).json()
      ).digests,
    ).toHaveLength(1);
    expect(
      (
        await (
          await post("/entities/archive-past", { scopeId: "belgrade" })
        ).json()
      ).archivedDigests,
    ).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

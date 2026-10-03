import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { Store } from "../server/store";
import { createApi } from "../server/api";
import { saveEntityState } from "../src/entity-state-api";

afterEach(() => vi.unstubAllGlobals());
it.each([
  { failure: "before-write", state: { reaction: "dislike" as const } },
  { failure: "after-write", state: { reaction: "dislike" as const } },
  { failure: "before-write", state: { skipped: true, skipReason: "дубль" } },
  { failure: "after-write", state: { skipped: true, skipReason: "дубль" } },
])(
  "recovers an empty HTTP response $failure for $state",
  async ({ failure, state }) => {
    const store = new Store(":memory:");
    let server: Server | undefined;
    try {
      store.ingest(store.source("source-manual"), [
        {
          entity: {
            type: "Event",
            title: "HTTP dislike",
            startAt: "2099-10-02",
          },
          raw: { externalId: "one", url: "", rawText: "", payload: {} },
        },
      ]);
      const id = store.entities()[0].id;
      const save = vi.spyOn(store, "setState");
      const app = express();
      let writes = 0;
      app.use((req, res, next) => {
        if (req.method !== "PATCH") return next();
        writes++;
        if (writes !== 1) return next();
        if (failure === "after-write") store.setState(id, state);
        res.status(failure === "before-write" ? 502 : 200).end();
      });
      server = await new Promise<Server>((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
        listening.on("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No TCP address");
      app.use(createApi(store, address.port));
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", (path: string, options: RequestInit) =>
        fetch(`http://127.0.0.1:${address.port}${path}`, {
          ...options,
        }),
      );
      const result = await saveEntityState(id, state);
      expect(result).toMatchObject(state);
      expect(store.entitySummary(id)).toMatchObject(state);
      expect(save).toHaveBeenCalledOnce();
      expect(writes).toBe(failure === "before-write" ? 2 : 1);
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      store.close();
    }
  },
);

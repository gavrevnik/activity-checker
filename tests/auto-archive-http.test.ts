import express from "express";
import type { Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";
import { saveAutoArchiveSettings } from "../server/auto-archive.js";

function addPast(store: Store) {
  store.ingest(store.source("source-manual"), [
    {
      entity: {
        type: "Event",
        title: "Startup past fixture",
        startAt: "2000-01-01",
      },
      raw: { externalId: "past-fixture", url: "", rawText: "", payload: {} },
    },
  ]);
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

it("round-trips the opt-out over HTTP without archiving on GET/PUT, rejects invalid input and preserves the manual button", async () => {
  const store = new Store(":memory:");
  const app = express();
  let server: Server | undefined;
  try {
    addPast(store);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    app.use(createApi(store, address.port));
    const base = `http://127.0.0.1:${address.port}/api`;
    expect(await (await fetch(`${base}/auto-archive/settings`)).json()).toEqual(
      { enabled: true },
    );
    const put = (body: unknown) =>
      fetch(`${base}/auto-archive/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await put({ enabled: false })).json()).toEqual({
      enabled: false,
    });
    expect((await put({ enabled: "false" })).status).toBe(400);
    expect((await put({ enabled: true, unknown: true })).status).toBe(400);
    expect(await (await fetch(`${base}/auto-archive/settings`)).json()).toEqual(
      { enabled: false },
    );
    expect(store.entities({ includeFiltered: true })).toHaveLength(1);
    const manual = await fetch(`${base}/entities/archive-past`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopeId: "belgrade" }),
    });
    expect((await manual.json()).archived).toBe(1);
  } finally {
    if (server) await close(server);
    store.close();
  }
});

it.each([true, false])(
  "real web process startup respects enabled=%s before it serves any requests (temporary DB only)",
  async (enabled) => {
    const dir = mkdtempSync(resolve(tmpdir(), "activity-auto-archive-test-"));
    const database = resolve(dir, "test.sqlite");
    let child: ChildProcess | undefined;
    try {
      const store = new Store(database);
      try {
        addPast(store);
        if (!enabled) saveAutoArchiveSettings(store, { enabled: false });
      } finally {
        store.close();
      }
      const reservation = express().listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        reservation.once("listening", resolve);
        reservation.once("error", reject);
      });
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const port = address.port;
      await close(reservation);
      child = spawn(
        process.execPath,
        ["--import", "tsx", "server/index.ts", "--production"],
        {
          cwd: resolve("."),
          env: { ...process.env, ACTIVITY_DB: database, PORT: String(port) },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Temporary web startup timed out")),
          10000,
        );
        let output = "";
        child!.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child!.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Temporary web process exited before listening"));
        });
        child!.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes(`http://127.0.0.1:${port}`)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auto-archive/settings`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled });
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM entities WHERE title='Startup past fixture'",
            )
            .get()!.count,
        ).toBe(enabled ? 0 : 1);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM past_events_archive WHERE title='Startup past fixture'",
            )
            .get()!.count,
        ).toBe(enabled ? 1 : 0);
      } finally {
        db.close();
      }
    } finally {
      if (child) await stop(child);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);

import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../server/store";
import { entitySchema } from "../shared/model";
import { parseSerbiaCalendar } from "../server/providers/websites/serbia-travel";
import {
  DailyLedger,
  quotaDay,
  withMcpBudget,
} from "../server/providers/google-places/mcp-budget";
import { searchGooglePlacesText } from "../server/providers/google-places/client";
import { server } from "../scripts/google-places-mcp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const temporaryDirectory = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "connector-safety-")));

it("atomically admits only one of two concurrent connections at the last daily slot", async () => {
  const directory = temporaryDirectory(),
    path = join(directory, "quota.sqlite");
  const date = new Date("2026-10-09T12:00:00Z"),
    ledger = new DailyLedger(path);
  const gate = new SharedArrayBuffer(8),
    flags = new Int32Array(gate);
  const workers: Worker[] = [];
  let ready = 0;
  try {
    ledger.db
      .prepare("INSERT INTO daily_usage(day,used) VALUES (?,99)")
      .run(quotaDay(date));
    const attempt = () =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker(
          `
        const {parentPort,workerData}=require('node:worker_threads');
        (async()=>{
          const {DailyLedger}=await import(workerData.module);
          const ledger=new DailyLedger(workerData.path), gate=new Int32Array(workerData.gate);
          parentPort.postMessage({ready:true});
          Atomics.wait(gate,1,0,15000);
          try{ledger.reserve(new Date(workerData.date));parentPort.postMessage({result:'accepted'});}
          catch{parentPort.postMessage({result:'denied'});}
          finally{ledger.close();}
        })().catch(error=>{throw error;});
      `,
          {
            eval: true,
            execArgv: ["--import", "tsx"],
            workerData: {
              module: new URL(
                "../server/providers/google-places/mcp-budget.ts",
                import.meta.url,
              ).href,
              path,
              gate,
              date: date.toISOString(),
            },
          },
        );
        workers.push(worker);
        worker.on("error", reject);
        worker.on("message", (value) => {
          if (value.ready && ++ready === 2) {
            Atomics.store(flags, 1, 1);
            Atomics.notify(flags, 1, 2);
          }
          if (value.result) resolve(value.result);
        });
      });
    expect((await Promise.all([attempt(), attempt()])).sort()).toEqual([
      "accepted",
      "denied",
    ]);
    expect(ledger.status(date).used).toBe(100);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

it("preserves the per-run cap across concurrent calls and counts a timeout without retry", async () => {
  const directory = temporaryDirectory();
  vi.stubEnv("GOOGLE_PLACES_MCP_QUOTA_DB", join(directory, "quota.sqlite"));
  const store = new Store(":memory:");
  const input = {
    query: "fixture",
    mode: "ids_only" as const,
    apiKey: "synthetic-provider-key",
  };
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response('{"places":[{"id":"fixture"}]}'));
  try {
    const result = await withMcpBudget(true, 1, async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 3 }, () => searchGooglePlacesText(input, store)),
      );
      return {
        accepted: outcomes.filter((o) => o.status === "fulfilled").length,
      };
    });
    expect(result.accepted).toBe(1);
    expect(result.budget.used).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValue(
      new DOMException("Fixture timeout", "TimeoutError"),
    );
    await expect(
      withMcpBudget(true, 1, () => searchGooglePlacesText(input, store)),
    ).rejects.toThrow("Fixture timeout");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM google_places_api_usage WHERE outcome='error'",
        )
        .get()?.n,
    ).toBe(1);
    const ledger = new DailyLedger();
    try {
      expect(ledger.status().used).toBe(2);
    } finally {
      ledger.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("enforces the budget through real MCP handlers and keeps dry-run free of HTTP and cards", async () => {
  const directory = temporaryDirectory(),
    path = join(directory, "fixture.sqlite");
  new Store(path).close();
  vi.stubEnv("ACTIVITY_DB", path);
  vi.stubEnv("GOOGLE_PLACES_MCP_QUOTA_DB", join(directory, "quota.sqlite"));
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "synthetic-provider-key");
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response('{"places":[{"id":"fixture-place"}]}'),
    );
  const [a, b] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: "offline-budget-test", version: "1" });
  try {
    await server.connect(b);
    await client.connect(a);
    const args = {
      queries: ["first", "second"],
      resultsPerQuery: 1,
      maxItems: 2,
      maxRequests: 1,
    };
    const dry = await client.callTool({
      name: "google_places_text_search_ids",
      arguments: args,
    });
    expect(dry.isError).not.toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const executed = await client.callTool({
      name: "google_places_text_search_ids",
      arguments: { ...args, execute: true },
    });
    expect(executed.isError).not.toBe(true);
    expect((executed.structuredContent as any).budget).toMatchObject({
      used: 1,
      allowed: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const store = Store.openExisting(path);
    try {
      expect(store.entities()).toHaveLength(0);
      expect(
        store.db
          .prepare("SELECT count(*) AS n FROM google_places_discovered_ids")
          .get()?.n,
      ).toBe(1);
    } finally {
      store.close();
    }
  } finally {
    await client.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps stable event identity, manual overrides and reactions after repeated shared-parser imports", () => {
  const store = new Store(":memory:");
  try {
    const source = store.source("source-serbia-travel"),
      ctx = { source, scope: store.scope("belgrade"), secrets: {} };
    const page = {
      html: '<div class="event-item"><a class="event-link" href="https://www.serbia.travel/en/events/fixture/"><div data-id="1"><p class="city">Belgrade</p></div><h2>Festival</h2><p class="date-from-to">10.10.2026</p><p class="categories">Music</p></a></div>',
      hasMore: false,
    };
    const sync = () =>
      store.ingest(
        source,
        parseSerbiaCalendar(page, ctx).items.map((raw) => ({
          raw,
          entity: entitySchema.parse((raw.payload as any).normalized),
        })),
      );
    sync();
    const id = store.entities()[0].id;
    const entity = store.entity(id);
    store.editEntity(id, {
      ...entitySchema.parse(
        Object.fromEntries(
          Object.keys(entitySchema.shape).map((key) => [
            key,
            (entity as any)[key],
          ]),
        ),
      ),
      title: "Personal title",
    });
    store.setState(id, {
      reaction: "like",
      favorite: true,
      notes: "Personal note",
    });
    sync();
    sync();
    expect(store.entities()).toHaveLength(1);
    expect(store.entity(id)).toMatchObject({
      id,
      title: "Personal title",
      reaction: "like",
      favorite: true,
      notes: "Personal note",
    });
    expect(store.entity(id).provenance).toHaveLength(1);
  } finally {
    store.close();
  }
});

import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createApi } from "../server/api";
import { Store } from "../server/store";
import {
  TelegramConnector,
  type TelegramTransport,
} from "@personal-radar/connectors/telegram";
import { SqliteTelegramBatchStore } from "../server/providers/telegram/batch-store";

it("offers a 50-source plan, preserves loopback guards and reads persisted results without credentials", async () => {
  const store = new Store(":memory:"),
    port = 15498,
    app = createApi(store, port),
    server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const input = {
      requestId: randomUUID(),
      operation: "recent",
      channels: Array.from({ length: 50 }, (_, i) => `source${i}`),
    };
    const call = (payload: unknown, origin?: string) =>
      fetch(base + "/api/telegram/batch-read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(payload),
      });
    const planned = await call(input);
    expect(planned.status).toBe(200);
    expect((await planned.json()).channels).toHaveLength(50);
    expect((await call(input, "https://untrusted.example")).status).toBe(403);
    expect(
      (await call({ ...input, channels: [...input.channels, "source50"] }))
        .status,
    ).toBe(400);
    const transport: TelegramTransport = {
      id: "fixture-v1",
      scope: "activity-checker-telegram",
      maxChannelsPerCall: 20,
      maxConcurrency: 1,
      capabilities: new Set(["recent"]),
      execute: async (request) => ({
        status: "complete",
        requestCount: 1,
        channels: request.targets.map((target) => ({
          target,
          status: "complete",
          channel: {
            id: "1",
            title: target,
            username: target,
            url: `https://t.me/${target}`,
            broadcast: true,
            megagroup: false,
            verified: false,
            participantsCount: null,
          },
          messages: [],
          cursor: null,
          watermarkCandidate: null,
          scannedCount: 0,
          filteredCount: 0,
          filterBreakdown: {},
          metadata: {},
        })),
        warnings: [],
      }),
    };
    const requestId = randomUUID();
    await new TelegramConnector({
      transport,
      batchStore: new SqliteTelegramBatchStore(store.db),
    }).batchRead({ requestId, operation: "recent", channels: ["alpha"] });
    const result = await fetch(base + `/api/telegram/batches/${requestId}`);
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe("complete");
    expect(store.entities()).toHaveLength(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  }
});

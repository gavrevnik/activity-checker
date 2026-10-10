import { saveTelegramMonitoringSettings } from "../server/telegram-monitoring-settings";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TelegramConnector,
  TelegramConnectorError,
  type TelegramTransport,
  type TransportRequest,
  type TransportLimits,
  type PhysicalResult,
  type TelegramChannelResult,
} from "@personal-radar/connectors/telegram";
import { Store } from "../server/store";
import { SqliteTelegramBatchStore } from "../server/providers/telegram/batch-store";
import {
  executeTelegramBatchRead,
  getTelegramBatchResult,
} from "../server/providers/telegram/batch";

const directories: string[] = [];
const stores: Store[] = [];
const directory = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "telegram-connector-")));
  directories.push(dir);
  return dir;
};
const open = (path: string) => {
  const store = new Store(path);
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {}
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const source = (target: string): TelegramChannelResult => {
  const id = String(Number(target.match(/\d+$/)?.[0] ?? 0) + 1);
  return {
    target,
    status: "complete",
    channel: {
      id,
      title: target,
      username: target,
      url: `https://t.me/${target}`,
      broadcast: true,
      megagroup: false,
      verified: false,
      participantsCount: null,
    },
    messages: [
      {
        id: "10",
        channelId: id,
        username: target,
        text: "Fixture with sufficient details for the shared Telegram filtering policy.",
        date: "2026-10-10T00:00:00Z",
      },
    ],
    cursor: null,
    watermarkCandidate: "10",
    scannedCount: 1,
    filteredCount: 0,
    filterBreakdown: {},
    metadata: {},
  };
};
class FixtureTransport implements TelegramTransport {
  id = "fixture-v1";
  scope = "activity-checker-telegram";
  maxChannelsPerCall = 20;
  maxConcurrency = 1;
  capabilities = new Set<TransportRequest["operation"]>([
    "recent",
    "pinned",
    "info",
    "search",
    "topics",
    "topicPosts",
    "linkedPosts",
    "comments",
    "compatibility",
  ]);
  requests: TransportRequest[] = [];
  constructor(public action?: (request: TransportRequest) => PhysicalResult) {}
  async execute(request: TransportRequest, limits: TransportLimits) {
    await limits.beforeRpc?.();
    this.requests.push(request);
    return (
      this.action?.(request) ?? {
        status: "complete" as const,
        requestCount: request.targets.length,
        channels: request.targets.map(source),
        warnings: [],
      }
    );
  }
}

it("persists 50 source results in the existing database and retrieves them without credentials or RPC", async () => {
  const path = join(directory(), "fixture.sqlite"),
    store = open(path),
    transport = new FixtureTransport();
  const tg = new TelegramConnector({
    transport,
    batchStore: new SqliteTelegramBatchStore(store.db),
  });
  const request = {
    requestId: randomUUID(),
    operation: "recent" as const,
    channels: Array.from({ length: 50 }, (_, i) => `source${i}`),
  };
  const result = await tg.batchRead(request);
  expect(result.status).toBe("complete");
  expect(result.messages).toHaveLength(50);
  expect(transport.requests).toHaveLength(10);
  expect(store.entities()).toHaveLength(0);
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = open(path);
  vi.stubEnv("TELEGRAM_API_ID", "");
  vi.stubEnv("TELEGRAM_API_HASH", "");
  const saved = await getTelegramBatchResult(
    { requestId: request.requestId },
    reopened,
  );
  expect(saved.messages).toHaveLength(50);
  expect(saved.status).toBe("complete");
  expect(transport.requests).toHaveLength(10);
});

it("reopens a partial request with independent cursor and no duplicate messages", async () => {
  const path = join(directory(), "fixture.sqlite"),
    store = open(path);
  let page = 0;
  const transport = new FixtureTransport((request) => {
    const row = source(request.targets[0]);
    if (page++ === 0) {
      row.status = "partial";
      row.cursor = { beforeMessageId: "9" };
      row.messages = [
        { ...row.messages[0], id: "10" },
        { ...row.messages[0], id: "9" },
      ];
    } else
      row.messages = [
        { ...row.messages[0], id: "9" },
        { ...row.messages[0], id: "8" },
      ];
    return {
      status: row.status,
      requestCount: 1,
      channels: [row],
      warnings: [],
    };
  });
  const request = {
    requestId: randomUUID(),
    operation: "recent" as const,
    channels: ["alpha"],
  };
  const first = await new TelegramConnector({
    transport,
    batchStore: new SqliteTelegramBatchStore(store.db),
  }).batchRead(request);
  expect(first.sources[0].watermark).toBeNull();
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = open(path);
  const second = await new TelegramConnector({
    transport,
    batchStore: new SqliteTelegramBatchStore(reopened.db),
  }).batchRead(request);
  expect(second.messages.map((m) => m.id)).toEqual(["10", "9", "8"]);
  expect(second.sources[0].watermark).toBe("10");
  expect(transport.requests[1].cursors.alpha.beforeMessageId).toBe("9");
});

it("SQL checkpoint CAS rejects stale owners without touching existing cards", async () => {
  const store = open(join(directory(), "fixture.sqlite")),
    journal = new SqliteTelegramBatchStore(store.db),
    transport = new FixtureTransport();
  const request = {
    requestId: randomUUID(),
    operation: "recent" as const,
    channels: ["alpha"],
  };
  await new TelegramConnector({ transport, batchStore: journal }).batchRead(
    request,
  );
  const record = (await journal.get(request.requestId))!;
  expect(
    await journal.compareAndSwap(request.requestId, record.revision - 1, {
      ...record,
      revision: record.revision,
    }),
  ).toBe(false);
  expect((await journal.get(request.requestId))?.messages).toEqual(
    record.messages,
  );
  expect(store.entities()).toHaveLength(0);
});

it("application batch planning preserves saved exclusions and performs no RPC or journal write", async () => {
  const store = open(join(directory(), "fixture.sqlite")),
    transport = new FixtureTransport(),
    tg = new TelegramConnector({ transport });
  saveTelegramMonitoringSettings(store.db, {
    excludedChannels: ["alpha"],
    excludeKeywords: ["blocked"],
    excludeReplies: true,
    excludeAdDisclosures: true,
  });
  const result = await executeTelegramBatchRead(
    {
      requestId: randomUUID(),
      operation: "recent",
      channels: ["alpha", "bravo"],
    },
    store,
    tg,
  );
  expect("execute" in result && result.execute).toBe(false);
  expect(transport.requests).toHaveLength(0);
  expect(
    store.db
      .prepare("SELECT count(*) AS n FROM telegram_connector_requests")
      .get()?.n,
  ).toBe(0);
});

it("unknown SQL dispatch remains blocked after process replacement", async () => {
  const path = join(directory(), "fixture.sqlite"),
    store = open(path),
    request = {
      requestId: randomUUID(),
      operation: "recent" as const,
      channels: ["alpha"],
    };
  const transport = new FixtureTransport();
  vi.spyOn(transport, "execute").mockRejectedValue(
    new TelegramConnectorError("timeout", "Unknown dispatch", undefined, true),
  );
  const first = await new TelegramConnector({
    transport,
    batchStore: new SqliteTelegramBatchStore(store.db),
  }).batchRead(request);
  expect(first.sources[0].status).toBe("unknown");
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const replacement = new FixtureTransport();
  const resumed = await new TelegramConnector({
    transport: replacement,
    batchStore: new SqliteTelegramBatchStore(open(path).db),
  }).batchRead(request);
  expect(resumed.sources[0].status).toBe("unknown");
  expect(replacement.requests).toHaveLength(0);
});

it("per-source overrides cannot remove saved Activity policy", async () => {
  const store = open(join(directory(), "fixture.sqlite")),
    transport = new FixtureTransport(),
    tg = new TelegramConnector({ transport });
  saveTelegramMonitoringSettings(store.db, {
    excludedChannels: ["alpha"],
    excludeKeywords: ["blocked"],
    excludeReplies: true,
    excludeAdDisclosures: true,
  });
  await executeTelegramBatchRead(
    {
      requestId: randomUUID(),
      operation: "recent",
      channels: ["alpha", "bravo"],
      optionsByChannel: {
        bravo: {
          filters: {
            excludeKeywords: [],
            excludeReplies: true,
            excludeAdDisclosures: true,
          },
        },
      },
      execute: true,
    },
    store,
    tg,
  );
  expect(transport.requests[0].targets).toEqual(["bravo"]);
  expect(transport.requests[0].optionsByTarget?.bravo.filters).toMatchObject({
    excludeKeywords: ["blocked"],
    excludeReplies: true,
    excludeAdDisclosures: true,
  });
  expect(store.entities()).toHaveLength(0);
});

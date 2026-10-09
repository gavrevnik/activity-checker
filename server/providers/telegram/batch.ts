import { z } from "zod";
import {
  TelegramConnector,
  batchReadSchema,
  publicChannelSchema,
  cursorSchema,
  filterSchema,
  type BatchStore,
  type BatchReadInput,
} from "@personal-radar/connectors/telegram";
import { LocalTelethonTransport } from "@personal-radar/connectors/telegram/local";
import { telegramRuntime } from "./client.js";
import { requiredSecrets, databasePath } from "./tool.js";
import {
  LazyTelegramBatchStore,
  SqliteTelegramBatchStore,
} from "./batch-store.js";
import { readTelegramMonitoringSettings } from "../../telegram-monitoring-settings.js";
import type { Store } from "../../store.js";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
export const telegramBatchToolShape = {
  requestId: z.uuid(),
  channels: z.array(publicChannelSchema).min(1).max(50),
  operation: z.enum([
    "recent",
    "info",
    "pinned",
    "search",
    "topics",
    "topicPosts",
    "linkedPosts",
    "comments",
  ]),
  options: z.record(z.string(), z.unknown()).default({}),
  cursors: z.record(z.string(), cursorSchema).default({}),
  optionsByChannel: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .default({}),
  concurrency: z.number().int().min(1).max(2).default(1),
  retryUnknown: z.boolean().default(false),
  retryFailed: z.boolean().default(false),
  execute: z.boolean().default(false),
};
export const telegramBatchToolSchema = z
  .object(telegramBatchToolShape)
  .strict();
export function activityTelegramConnector(
  batchStore: BatchStore = new LazyTelegramBatchStore(),
  options: {
    createTransport?: (
      runtime: ReturnType<typeof telegramRuntime>,
    ) => LocalTelethonTransport;
  } = {},
) {
  const secrets = requiredSecrets();
  const runtime = telegramRuntime({
    apiId: secrets.TELEGRAM_API_ID!,
    apiHash: secrets.TELEGRAM_API_HASH!,
    pythonPath: secrets.TELEGRAM_PYTHON,
    sessionPath: secrets.TELEGRAM_SESSION_PATH,
  });
  const transport =
    options.createTransport?.(runtime) ??
    new LocalTelethonTransport({
      runtime,
      root: fileURLToPath(new URL("../../../", import.meta.url)),
      scope: "activity-checker-telegram",
    });
  return new TelegramConnector({ transport, batchStore });
}
export async function executeTelegramBatchRead(
  input: unknown,
  store?: Store,
  connector?: TelegramConnector,
) {
  const args = telegramBatchToolSchema.parse(input),
    { execute, ...request } = args;
  let settings;
  if (store) settings = readTelegramMonitoringSettings(store.db);
  else {
    const db = new DatabaseSync(databasePath(), { readOnly: true });
    try {
      settings = readTelegramMonitoringSettings(db);
    } finally {
      db.close();
    }
  }
  {
    const applyProfile = (input: unknown, parent: unknown = {}) => {
      const local = filterSchema.parse(input ?? {}),
        base = filterSchema.parse(parent ?? {});
      return {
        ...base,
        ...local,
        excludedChannels: [
          ...new Set([
            ...base.excludedChannels,
            ...local.excludedChannels,
            ...settings.excludedChannels,
          ]),
        ],
        excludedChannelIds: [
          ...new Set([...base.excludedChannelIds, ...local.excludedChannelIds]),
        ],
        excludeKeywords: [
          ...new Set([
            ...base.excludeKeywords,
            ...local.excludeKeywords,
            ...settings.excludeKeywords,
          ]),
        ],
        excludeAdDisclosures:
          settings.excludeAdDisclosures ||
          base.excludeAdDisclosures ||
          local.excludeAdDisclosures,
        excludeReplies: ["topicPosts", "comments", "linkedPosts"].includes(
          request.operation,
        )
          ? false
          : settings.excludeReplies ||
            base.excludeReplies ||
            local.excludeReplies,
      };
    };
    const root = (request.options as { filters?: unknown }).filters;
    request.options = { ...request.options, filters: applyProfile(root) };
    request.optionsByChannel = Object.fromEntries(
      Object.entries(request.optionsByChannel).map(([channel, override]) => [
        channel,
        { ...override, filters: applyProfile(override.filters, root) },
      ]),
    );
  }
  if (!request.channels.length)
    return {
      execute,
      requestId: args.requestId,
      status: "complete",
      requestCount: 0,
      sources: [],
      messages: [],
      warnings: ["Все sources исключены настройками"],
      hasMore: false,
      hasUnread: false,
      nextOffset: null,
      offset: 0,
      attempts: 0,
    };
  const parsed = batchReadSchema.parse(request);
  if (!execute)
    return {
      execute: false,
      requestId: args.requestId,
      operation: parsed.operation,
      channels: parsed.channels,
      physicalBatchSize: 5,
      effectiveLocalConcurrency: 1,
      maxRpcRequests: 500,
      maxRunMs: 45000,
      warnings: [],
      note: "Сохраняйте requestId; execute=true разрешает RPC и operational journal, без импорта карточек",
    };
  return (
    connector ??
    activityTelegramConnector(
      store ? new SqliteTelegramBatchStore(store.db) : undefined,
    )
  ).batchRead(parsed as BatchReadInput);
}
export async function getTelegramBatchResult(
  input: {
    requestId: string;
    offset?: number;
    limit?: number;
    source?: string;
  },
  store?: Store,
  connector?: TelegramConnector,
) {
  if (connector) return connector.getBatchResult(input);
  const reader = new TelegramConnector({
    transport: {
      id: "local-telethon-v1",
      scope: "activity-checker-telegram",
      maxChannelsPerCall: 20,
      maxConcurrency: 1,
      capabilities: new Set(),
      execute: async () => {
        throw new Error("Journal reader never performs RPC");
      },
    },
    batchStore: store
      ? new SqliteTelegramBatchStore(store.db)
      : new LazyTelegramBatchStore(),
  });
  return reader.getBatchResult(input);
}

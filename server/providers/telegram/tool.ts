import { radarIdFor } from "@personal-radar/connectors/catalog-sync";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parse } from "dotenv";
import { z } from "zod";
import { readSecrets } from "../../secrets.js";
import { readTelegramMonitoringSettings } from "../../telegram-monitoring-settings.js";
import { telegramUsername } from "../../../shared/telegram-monitoring.js";
import { telegramEntity, telegramRawItem } from "./provider.js";
import {
  executeTelegramBatch,
  monitorTelegramChannels,
  normalizeTelegramQueries,
  sampleTelegramChannels,
  telegramDiscoveryOperations,
  telegramStatus,
} from "./client.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export const telegramToolInputSchema = z
  .object({
    queries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    operations: z.array(z.enum(telegramDiscoveryOperations)).min(1).max(2),
    seedChannels: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .default([]),
    resultsPerQuery: z.number().int().min(1).max(50).default(10),
    maxItems: z.number().int().min(1).max(500).default(100),
    minParticipants: z.number().int().min(0).max(10_000_000).default(0),
    store: z.boolean().default(false),
    sourceId: z.string().min(1).max(200).default("source-telegram"),
  })
  .strict();

export function requiredSecrets() {
  const secrets = readSecrets();
  if (!secrets.TELEGRAM_API_ID || !secrets.TELEGRAM_API_HASH)
    throw new Error(
      "TELEGRAM_API_ID и TELEGRAM_API_HASH не найдены в .env.local.",
    );
  return secrets;
}

export function databasePath() {
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(resolve(root, ".env.local")));
  } catch {}
  return (
    process.env.ACTIVITY_DB ||
    file.ACTIVITY_DB ||
    resolve(root, "../data/activity-checker/activity.sqlite")
  );
}

function normalizedHistorySeed(value: string) {
  const match = value
    .trim()
    .match(/^https?:\/\/(?:www\.)?t\.me\/(?:s\/)?([A-Za-z0-9_]{5,})\/?/i);
  return match ? match[1] : value.trim().replace(/^@/, "");
}

export async function getTelegramToolStatus() {
  const secrets = requiredSecrets();
  return await telegramStatus({
    apiId: secrets.TELEGRAM_API_ID!,
    apiHash: secrets.TELEGRAM_API_HASH!,
    pythonPath: secrets.TELEGRAM_PYTHON,
    sessionPath: secrets.TELEGRAM_SESSION_PATH,
  });
}

export async function sampleTelegramChannelPosts(input: {
  channels: string[];
  messagesPerChannel?: number;
}) {
  const secrets = requiredSecrets();
  return await sampleTelegramChannels({
    channels: input.channels,
    messagesPerChannel: input.messagesPerChannel,
    delaySeconds: 2.5,
    apiId: secrets.TELEGRAM_API_ID!,
    apiHash: secrets.TELEGRAM_API_HASH!,
    pythonPath: secrets.TELEGRAM_PYTHON,
    sessionPath: secrets.TELEGRAM_SESSION_PATH,
  });
}

export interface TelegramMonitoringChannel {
  radarId?: string;
  communityId: string;
  title: string;
  username: string;
  url: string;
  memberCount: number | null;
  tags: string[];
  archived: boolean;
  filtered: boolean;
}

function usernameFromCommunity(data: Record<string, unknown>) {
  const knownIds =
    data.knownIds && typeof data.knownIds === "object"
      ? (data.knownIds as Record<string, unknown>)
      : {};
  const known = knownIds.telegram_username;
  if (typeof known === "string" && known.trim())
    return normalizedHistorySeed(known);
  const url = typeof data.url === "string" ? data.url : "";
  const username = normalizedHistorySeed(url);
  return username !== url ? username : "";
}

export function getTelegramMonitoringChannels(
  input: {
    includeArchived?: boolean;
    includeFiltered?: boolean;
    includeExcluded?: boolean;
    limit?: number;
  } = {},
): TelegramMonitoringChannel[] {
  const database = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    return listTelegramMonitoringChannels(database, input);
  } finally {
    database.close();
  }
}

export function listTelegramMonitoringChannels(
  database: DatabaseSync,
  input: {
    includeArchived?: boolean;
    includeFiltered?: boolean;
    includeExcluded?: boolean;
    limit?: number;
  } = {},
): TelegramMonitoringChannel[] {
  const settings = readTelegramMonitoringSettings(database);
  const conditions = ["type='Community'"];
  if (!input.includeArchived) conditions.push("archived=0");
  if (!input.includeFiltered) conditions.push("filtered=0");
  const rows = database
    .prepare(
      `SELECT id,data,overrides,archived,filtered FROM entities WHERE ${conditions.join(" AND ")} ORDER BY updatedAt DESC,id LIMIT ?`,
    )
    .all(Math.max(1, Math.min(input.limit || 200, 1000))) as Array<{
    id: string;
    data: string;
    overrides: string;
    archived: number;
    filtered: number;
  }>;
  return rows.flatMap((row) => {
    const data = {
      ...JSON.parse(row.data),
      ...JSON.parse(row.overrides),
    } as Record<string, unknown>;
    const username = usernameFromCommunity(data);
    if (!username) return [];
    if (
      !input.includeExcluded &&
      settings.excludedChannels.includes(telegramUsername(username))
    )
      return [];
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const knownIds =
      data.knownIds && typeof data.knownIds === "object"
        ? (data.knownIds as Record<string, unknown>)
        : {};
    const telegram =
      typeof knownIds.telegram === "string" ||
      typeof knownIds.telegram_channel === "string" ||
      typeof knownIds.telegram_username === "string" ||
      tags.includes("telegram") ||
      (typeof data.url === "string" &&
        /^https?:\/\/(?:www\.)?t\.me\//i.test(data.url));
    if (!telegram) return [];
    return [
      {
        communityId: row.id,
        ...(radarIdFor(database, "entities", row.id)
          ? { radarId: radarIdFor(database, "entities", row.id)! }
          : {}),
        title: String(data.title || `@${username}`),
        username,
        url: `https://t.me/${username}`,
        memberCount:
          typeof data.memberCount === "number" ? data.memberCount : null,
        tags: tags.filter((tag): tag is string => typeof tag === "string"),
        archived: Boolean(row.archived),
        filtered: Boolean(row.filtered),
      },
    ];
  });
}

export async function monitorTelegramChannelPosts(input: {
  channels?: string[];
  communityIds?: string[];
  allStoredChannels?: boolean;
  startDate?: string;
  endDate?: string;
  timeZone?: string;
  maxPostsPerChannel?: number;
  maxScannedPerChannel?: number;
  pageSize?: number;
  afterMessageIds?: Record<string, string>;
  beforeMessageIds?: Record<string, string>;
  minViews?: number;
  minTextLength?: number;
  excludeForwards?: boolean;
  excludeReplies?: boolean;
  excludeMediaOnly?: boolean;
  excludeAdDisclosures?: boolean;
  excludeKeywords?: string[];
  excludeHashtags?: string[];
  excludeLinkDomains?: string[];
  excludeMediaTypes?: string[];
  delaySeconds?: number;
}) {
  const stored =
    input.communityIds?.length || input.allStoredChannels
      ? getTelegramMonitoringChannels({ limit: 1000, includeExcluded: true })
      : [];
  const byId = new Map(stored.map((channel) => [channel.communityId, channel]));
  const missingIds = (input.communityIds || []).filter((id) => !byId.has(id));
  if (missingIds.length)
    throw new Error(
      `Telegram communities не найдены или скрыты: ${missingIds.join(", ")}`,
    );
  const selected = [
    ...(input.channels || []),
    ...(input.communityIds || []).flatMap((id) => {
      const channel = byId.get(id);
      return channel ? [channel.username] : [];
    }),
    ...(input.allStoredChannels
      ? stored.map((channel) => channel.username)
      : []),
  ];
  const database = new DatabaseSync(databasePath(), { readOnly: true });
  let settings;
  try {
    settings = readTelegramMonitoringSettings(database);
  } finally {
    database.close();
  }
  const requested = [
    ...new Map(
      selected
        .map(normalizedHistorySeed)
        .filter(Boolean)
        .map((username) => [username.toLowerCase(), username]),
    ).values(),
  ];
  if (!requested.length)
    throw new Error(
      "Укажите channels/communityIds или allStoredChannels=true.",
    );
  const skipped = requested.filter((username) =>
    settings.excludedChannels.includes(telegramUsername(username)),
  );
  const channels = requested.filter(
    (username) =>
      !settings.excludedChannels.includes(telegramUsername(username)),
  );
  const warnings = skipped.length
    ? [
        `Исключены настройками, без запросов к Telegram: ${skipped.map((username) => `@${username}`).join(", ")}`,
      ]
    : [];
  if (!channels.length)
    return {
      ok: true as const,
      requestCount: 0,
      range: {
        startDate: input.startDate || null,
        endDate: input.endDate || null,
        timeZone: input.timeZone || "Europe/Belgrade",
      },
      channels: [],
      warnings,
      billing: {
        perResultUsd: 0,
        paidStarsAllowed: false,
        note: "Все каналы исключены; запросов к Telegram не было.",
      },
    };
  if (channels.length > 20)
    throw new Error(
      `За один monitoring batch допустимо до 20 каналов; выбрано ${channels.length}. Разбейте список на batch.`,
    );
  const secrets = requiredSecrets();
  const {
    communityIds: _ids,
    allStoredChannels: _all,
    ...monitoringInput
  } = input;
  const result = await monitorTelegramChannels({
    ...monitoringInput,
    excludeKeywords: [
      ...new Set([
        ...settings.excludeKeywords,
        ...(input.excludeKeywords || []),
      ]),
    ],
    excludeReplies: settings.excludeReplies || Boolean(input.excludeReplies),
    excludeAdDisclosures:
      settings.excludeAdDisclosures || Boolean(input.excludeAdDisclosures),
    channels,
    apiId: secrets.TELEGRAM_API_ID!,
    apiHash: secrets.TELEGRAM_API_HASH!,
    pythonPath: secrets.TELEGRAM_PYTHON,
    sessionPath: secrets.TELEGRAM_SESSION_PATH,
  });
  return {
    ...result,
    warnings: [...warnings, ...result.warnings],
    sourceReferences: stored
      .filter((s) => channels.includes(s.username) && s.radarId)
      .map((s) => ({
        username: s.username,
        communityId: s.communityId,
        radarId: s.radarId,
      })),
  };
}

export async function executeTelegramTool(
  input: z.input<typeof telegramToolInputSchema>,
) {
  const args = telegramToolInputSchema.parse(input);
  const secrets = requiredSecrets();
  const response = await executeTelegramBatch({
    queries: normalizeTelegramQueries(args.queries),
    operations: args.operations,
    seedChannels: args.seedChannels,
    resultsPerQuery: args.resultsPerQuery,
    maxItems: args.maxItems,
    minParticipants: args.minParticipants,
    delaySeconds: 2.5,
    apiId: secrets.TELEGRAM_API_ID!,
    apiHash: secrets.TELEGRAM_API_HASH!,
    pythonPath: secrets.TELEGRAM_PYTHON,
    sessionPath: secrets.TELEGRAM_SESSION_PATH,
  });
  const { Store } = await import("../../store.js");
  const store = new Store(databasePath());
  try {
    let stored = null;
    if (args.store) {
      const source = store.source(args.sourceId);
      if (source.providerId !== "telegram")
        throw new Error(
          "sourceId должен указывать на Telegram MTProto source.",
        );
      const ctx = {
        source,
        scope: store.scope(source.scopeId),
        secrets,
      };
      const records = response.results.map((item) => ({
        raw: telegramRawItem(item),
        entity: telegramEntity(item, ctx),
      }));
      stored = store.ingest(source, records);
    }
    const historyRunId = randomUUID();
    const executedAt = new Date().toISOString();
    const normalizedQueries = normalizeTelegramQueries(args.queries);
    const queryEntries = args.operations.flatMap((operation) => {
      const queries =
        operation === "channels.getChannelRecommendations"
          ? args.seedChannels.length
            ? args.seedChannels.map(normalizedHistorySeed)
            : ["(account recommendations)"]
          : normalizedQueries;
      return queries.map((query) => ({ operation, query }));
    });
    const insert = store.db.prepare(
      "INSERT INTO telegram_query_history (id,runId,executedAt,operation,query,minParticipants,resultsPerQuery,returnedCount,relevantCount,storedCount,resultUsernames,notes) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)",
    );
    store.transaction(() => {
      for (const entry of queryEntries) {
        const usernames = [
          ...new Set(
            response.results
              .filter(
                (item) =>
                  item.operations.includes(entry.operation) &&
                  item.matchedQueries.includes(entry.query),
              )
              .map((item) => item.channel.username),
          ),
        ];
        insert.run(
          randomUUID(),
          historyRunId,
          executedAt,
          entry.operation,
          entry.query,
          args.minParticipants,
          args.resultsPerQuery,
          usernames.length,
          args.store ? usernames.length : 0,
          JSON.stringify(usernames),
          "",
        );
      }
    });
    return {
      ...response,
      stored,
      historyRunId,
    };
  } finally {
    store.close();
  }
}

function normalizedUsernames(values: string[]) {
  return new Set(
    values.map((value) => value.trim().replace(/^@/, "").toLowerCase()),
  );
}

export async function markTelegramQueryHistory(input: {
  runId: string;
  relevantUsernames: string[];
  storedUsernames?: string[];
  notes?: string;
}) {
  const { Store } = await import("../../store.js");
  const store = new Store(databasePath());
  try {
    const rows = store.db
      .prepare(
        "SELECT id,resultUsernames FROM telegram_query_history WHERE runId=?",
      )
      .all(input.runId) as Array<{ id: string; resultUsernames: string }>;
    if (!rows.length) throw new Error("Telegram history run не найден.");
    const relevant = normalizedUsernames(input.relevantUsernames);
    const stored = normalizedUsernames(input.storedUsernames || []);
    const update = store.db.prepare(
      "UPDATE telegram_query_history SET relevantCount=?,storedCount=?,notes=? WHERE id=?",
    );
    store.transaction(() => {
      for (const row of rows) {
        const usernames = JSON.parse(row.resultUsernames) as string[];
        update.run(
          usernames.filter((username) => relevant.has(username.toLowerCase()))
            .length,
          usernames.filter((username) => stored.has(username.toLowerCase()))
            .length,
          input.notes || "",
          row.id,
        );
      }
    });
    return { runId: input.runId, queriesUpdated: rows.length };
  } finally {
    store.close();
  }
}

export async function getTelegramQueryHistory(limit = 200) {
  const { Store } = await import("../../store.js");
  const store = new Store(databasePath());
  try {
    return store.db
      .prepare(
        "SELECT runId,executedAt,operation,query,minParticipants,resultsPerQuery,returnedCount,relevantCount,storedCount,notes FROM telegram_query_history ORDER BY executedAt DESC,id LIMIT ?",
      )
      .all(Math.max(1, Math.min(limit, 1000)));
  } finally {
    store.close();
  }
}

export function compactTelegramResult(
  input: Awaited<ReturnType<typeof executeTelegramTool>>,
) {
  return {
    ...input,
    results: input.results.map((item) => ({
      ...item,
      ...(item.post
        ? {
            post: {
              ...item.post,
              text:
                item.post.text.length > 4000
                  ? item.post.text.slice(0, 3997) + "…"
                  : item.post.text,
            },
          }
        : {}),
    })),
  };
}

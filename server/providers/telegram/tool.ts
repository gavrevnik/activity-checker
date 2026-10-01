import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { z } from "zod";
import { readSecrets } from "../../secrets.js";
import { telegramEntity, telegramRawItem } from "./provider.js";
import {
  executeTelegramBatch,
  normalizeTelegramQueries,
  sampleTelegramChannels,
  telegramOperations,
  telegramStatus,
} from "./client.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export const telegramToolInputSchema = z
  .object({
    queries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    operations: z.array(z.enum(telegramOperations)).min(1).max(4),
    seedChannels: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .default([]),
    resultsPerQuery: z.number().int().min(1).max(50).default(10),
    maxItems: z.number().int().min(1).max(500).default(100),
    minParticipants: z.number().int().min(0).max(10_000_000).default(0),
    minDate: z.iso.date().optional(),
    maxDate: z.iso.date().optional(),
    store: z.boolean().default(false),
    sourceId: z.string().min(1).max(200).default("source-telegram"),
  })
  .strict();

function requiredSecrets() {
  const secrets = readSecrets();
  if (!secrets.TELEGRAM_API_ID || !secrets.TELEGRAM_API_HASH)
    throw new Error(
      "TELEGRAM_API_ID и TELEGRAM_API_HASH не найдены в .env.local.",
    );
  return secrets;
}

function databasePath() {
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
    minDate: args.minDate,
    maxDate: args.maxDate,
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

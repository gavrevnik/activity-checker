import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import monitoringFilters from "../../../data/telegram-monitoring-filters.json" with { type: "json" };

export const telegramOperations = [
  "searchPublicChats",
  "channels.searchPosts",
  "messages.searchGlobal",
  "channels.getChannelRecommendations",
] as const;
export type TelegramOperation = (typeof telegramOperations)[number];

// Full-text post search and global message search remain parse-compatible for
// already stored raw rows, but are intentionally not exposed by discovery.
// Re-enable them here only if we deliberately decide to use those APIs again.
export const telegramDiscoveryOperations = [
  "searchPublicChats",
  "channels.getChannelRecommendations",
] as const;
export type TelegramDiscoveryOperation =
  (typeof telegramDiscoveryOperations)[number];

export const channelSchema = z.object({
  id: z.string(),
  title: z.string(),
  username: z.string(),
  url: z.url(),
  broadcast: z.boolean(),
  megagroup: z.boolean(),
  verified: z.boolean(),
  participantsCount: z.number().nullable().optional(),
});
const postSchema = z.object({
  id: z.string(),
  text: z.string(),
  date: z.string().nullable(),
  views: z.number().nullable().optional(),
  forwards: z.number().nullable().optional(),
  url: z.url(),
});
export const telegramResultSchema = z.object({
  kind: z.enum(["channel", "post"]),
  operations: z.array(z.enum(telegramOperations)),
  matchedQueries: z.array(z.string()),
  channel: channelSchema,
  post: postSchema.optional(),
});
export type TelegramSearchResult = z.output<typeof telegramResultSchema>;

const batchInputSchema = z
  .object({
    queries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    operations: z.array(z.enum(telegramDiscoveryOperations)).min(1),
    seedChannels: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .default([]),
    resultsPerQuery: z.number().int().min(1).max(50).default(10),
    maxItems: z.number().int().min(1).max(500).default(100),
    minParticipants: z.number().int().min(0).max(10_000_000).default(0),
    delaySeconds: z.number().min(2).max(30).default(2.5),
    apiId: z.string().regex(/^\d+$/),
    apiHash: z.string().min(20),
    pythonPath: z.string().optional(),
    sessionPath: z.string().optional(),
  })
  .strict();

const workerResponseSchema = z.object({
  ok: z.literal(true),
  requestCount: z.number().int().min(0),
  resultCount: z.number().int().min(0),
  operations: z.array(z.enum(telegramOperations)),
  results: z.array(telegramResultSchema),
  warnings: z.array(z.string()),
  billing: z.object({
    perResultUsd: z.number(),
    paidStarsAllowed: z.boolean(),
    note: z.string(),
  }),
});
const statusSchema = z.object({
  ok: z.literal(true),
  authorized: z.boolean(),
  account: z
    .object({
      id: z.string(),
      username: z.string().nullable().optional(),
      name: z.string(),
    })
    .nullable(),
});
const sampleResponseSchema = z.object({
  ok: z.literal(true),
  requestCount: z.number().int().min(0),
  samples: z.array(
    z.object({
      username: z.string(),
      url: z.url(),
      posts: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          date: z.string().nullable(),
          url: z.url(),
        }),
      ),
    }),
  ),
  warnings: z.array(z.string()),
  billing: z.object({
    perResultUsd: z.number(),
    paidStarsAllowed: z.boolean(),
    note: z.string(),
  }),
});

const monitoringEntitySchema = z.object({
  type: z.string(),
  text: z.string(),
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
  url: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  documentId: z.string().nullable().optional(),
});

export const monitoringPostSchema = z.object({
  id: z.string(),
  text: z.string(),
  date: z.string(),
  editDate: z.string().nullable(),
  url: z.url(),
  authorSignature: z.string().nullable(),
  senderId: z.string().nullable(),
  viaBotId: z.string().nullable(),
  groupedId: z.string().nullable(),
  replyToMessageId: z.string().nullable(),
  replyToTopId: z.string().nullable(),
  isPost: z.boolean(),
  isForwarded: z.boolean(),
  isReply: z.boolean(),
  isPinned: z.boolean(),
  isSilent: z.boolean(),
  noForwards: z.boolean(),
  views: z.number().int().nullable(),
  forwards: z.number().int().nullable(),
  replyCount: z.number().int().nullable(),
  reactionCount: z.number().int(),
  reactions: z.array(
    z.object({
      reaction: z.string(),
      count: z.number().int().min(0),
      chosen: z.boolean(),
    }),
  ),
  media: z.record(z.string(), z.unknown()).nullable(),
  entities: z.array(monitoringEntitySchema),
  hashtags: z.array(z.string()),
  mentions: z.array(z.string()),
  links: z.array(z.string()),
  buttons: z.array(z.object({ text: z.string(), url: z.string().nullable() })),
  forward: z.record(z.string(), z.unknown()).nullable(),
  restrictionReasons: z.array(
    z.object({
      platform: z.string(),
      reason: z.string(),
      text: z.string(),
    }),
  ),
  signals: z.object({
    hasText: z.boolean(),
    hasMedia: z.boolean(),
    hasExternalLink: z.boolean(),
    hasTelegramLink: z.boolean(),
    hasPrice: z.boolean(),
    hasPromoLanguage: z.boolean(),
    hasAdDisclosure: z.boolean(),
  }),
});

export const telegramMonitoringResponseSchema = z.object({
  ok: z.literal(true),
  requestCount: z.number().int().min(0),
  range: z.object({
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    timeZone: z.string(),
  }),
  channels: z.array(
    z.object({
      channel: channelSchema,
      scannedCount: z.number().int().min(0),
      returnedCount: z.number().int().min(0),
      filteredCount: z.number().int().min(0),
      filterBreakdown: z.record(z.string(), z.number().int().min(0)),
      truncated: z.boolean(),
      nextBeforeMessageId: z.string().nullable(),
      posts: z.array(monitoringPostSchema),
    }),
  ),
  warnings: z.array(z.string()),
  billing: z.object({
    perResultUsd: z.number(),
    paidStarsAllowed: z.boolean(),
    note: z.string(),
  }),
});
export type TelegramMonitoringResponse = z.output<
  typeof telegramMonitoringResponseSchema
>;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const worker = resolve(root, "workers/telegram_mtproto.py");
const defaultPython = resolve(root, ".venv-telegram/bin/python");
const defaultSession = resolve(
  root,
  "../data/activity-checker/telegram/activity-checker",
);

export function normalizeTelegramQueries(values: string[]) {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 30);
}

export function telegramQueriesFromText(value: string) {
  return normalizeTelegramQueries(value.split(/[\n\r]+|\s*;\s*/));
}

export function telegramRuntime(options: {
  apiId: string;
  apiHash: string;
  pythonPath?: string;
  sessionPath?: string;
}) {
  const python =
    options.pythonPath || process.env.TELEGRAM_PYTHON || defaultPython;
  try {
    accessSync(python, constants.X_OK);
  } catch {
    throw new Error(
      "Telethon environment не найден. Выполните npm run telegram:setup.",
    );
  }
  return {
    python,
    worker,
    env: {
      ...process.env,
      TELEGRAM_API_ID: options.apiId,
      TELEGRAM_API_HASH: options.apiHash,
      TELEGRAM_SESSION_PATH:
        options.sessionPath ||
        process.env.TELEGRAM_SESSION_PATH ||
        defaultSession,
      PYTHONUNBUFFERED: "1",
    },
  };
}

export async function runWorker(
  command: "status" | "search" | "sample" | "monitor" | "research",
  runtime: ReturnType<typeof telegramRuntime>,
  payload?: unknown,
) {
  return await new Promise<unknown>((resolvePromise, reject) => {
    const child = spawn(runtime.python, [runtime.worker, command], {
      cwd: root,
      env: runtime.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(
          new Error(
            `Telegram worker превысил лимит времени ${command === "monitor" || command === "research" ? 15 : 5} минут.`,
          ),
        );
      },
      command === "monitor" || command === "research" ? 900_000 : 300_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 20 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        reject(
          new Error(
            `Telegram worker вернул невалидный ответ${stderr ? `: ${stderr}` : ""}`,
          ),
        );
        return;
      }
      if (
        code !== 0 ||
        !parsed ||
        typeof parsed !== "object" ||
        !("ok" in parsed) ||
        !(parsed as { ok: boolean }).ok
      ) {
        const error =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : "Telegram worker завершился с ошибкой.";
        reject(new Error(error));
        return;
      }
      resolvePromise(parsed);
    });
    child.stdin.end(payload === undefined ? "" : JSON.stringify(payload));
  });
}

export async function telegramStatus(input: {
  apiId: string;
  apiHash: string;
  pythonPath?: string;
  sessionPath?: string;
}) {
  const runtime = telegramRuntime(input);
  return statusSchema.parse(await runWorker("status", runtime));
}

export async function executeTelegramBatch(
  input: z.input<typeof batchInputSchema>,
) {
  const args = batchInputSchema.parse(input);
  const queries = normalizeTelegramQueries(args.queries);
  const runtime = telegramRuntime(args);
  return workerResponseSchema.parse(
    await runWorker("search", runtime, { ...args, queries }),
  );
}

export async function sampleTelegramChannels(input: {
  channels: string[];
  messagesPerChannel?: number;
  delaySeconds?: number;
  apiId: string;
  apiHash: string;
  pythonPath?: string;
  sessionPath?: string;
}) {
  const args = z
    .object({
      channels: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
      messagesPerChannel: z.number().int().min(1).max(10).default(3),
      delaySeconds: z.number().min(2).max(30).default(2.5),
      apiId: z.string().regex(/^\d+$/),
      apiHash: z.string().min(20),
      pythonPath: z.string().optional(),
      sessionPath: z.string().optional(),
    })
    .strict()
    .parse(input);
  const runtime = telegramRuntime(args);
  return sampleResponseSchema.parse(await runWorker("sample", runtime, args));
}

export async function monitorTelegramChannels(input: {
  channels: string[];
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
  apiId: string;
  apiHash: string;
  pythonPath?: string;
  sessionPath?: string;
}) {
  const args = z
    .object({
      channels: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
      startDate: z.iso.date().optional(),
      endDate: z.iso.date().optional(),
      timeZone: z.string().trim().min(1).max(100).default("Europe/Belgrade"),
      maxPostsPerChannel: z.number().int().min(1).max(500).default(100),
      maxScannedPerChannel: z.number().int().min(1).max(5000).default(500),
      pageSize: z.number().int().min(10).max(100).default(100),
      afterMessageIds: z
        .record(z.string(), z.string().regex(/^\d+$/))
        .default({}),
      beforeMessageIds: z
        .record(z.string(), z.string().regex(/^\d+$/))
        .default({}),
      minViews: z.number().int().min(0).default(0),
      minTextLength: z.number().int().min(0).max(20_000).default(0),
      excludeForwards: z.boolean().default(false),
      excludeReplies: z.boolean().default(true),
      excludeMediaOnly: z.boolean().default(false),
      excludeAdDisclosures: z.boolean().default(true),
      excludeKeywords: z
        .array(z.string().trim().min(1).max(200))
        .max(100)
        .default(monitoringFilters.excludeKeywords),
      excludeHashtags: z
        .array(z.string().trim().min(1).max(100))
        .max(100)
        .default([]),
      excludeLinkDomains: z
        .array(z.string().trim().min(1).max(253))
        .max(100)
        .default([]),
      excludeMediaTypes: z
        .array(z.string().trim().min(1).max(100))
        .max(50)
        .default([]),
      delaySeconds: z.number().min(3).max(30).default(4),
      apiId: z.string().regex(/^\d+$/),
      apiHash: z.string().min(20),
      pythonPath: z.string().optional(),
      sessionPath: z.string().optional(),
    })
    .strict()
    .refine(
      (value) =>
        !value.startDate || !value.endDate || value.startDate <= value.endDate,
      { message: "startDate не может быть позже endDate." },
    )
    .parse(input);
  const runtime = telegramRuntime(args);
  return telegramMonitoringResponseSchema.parse(
    await runWorker("monitor", runtime, args),
  );
}

export async function authorizeTelegramInteractive(input: {
  apiId: string;
  apiHash: string;
  pythonPath?: string;
  sessionPath?: string;
}) {
  const runtime = telegramRuntime(input);
  return await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(runtime.python, [runtime.worker, "authorize"], {
      cwd: root,
      env: runtime.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Авторизация завершилась с кодом ${code}.`));
    });
  });
}

export function estimatedTelegramRequests(input: {
  queryCount: number;
  operations: TelegramDiscoveryOperation[];
  seedCount: number;
}) {
  const queryOperations = input.operations.filter(
    (operation) => operation !== "channels.getChannelRecommendations",
  ).length;
  const recommendationRequests = input.operations.includes(
    "channels.getChannelRecommendations",
  )
    ? input.seedCount
      ? input.seedCount * 2
      : 1
    : 0;
  return input.queryCount * queryOperations + recommendationRequests;
}

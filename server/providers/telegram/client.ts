import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const telegramOperations = [
  "searchPublicChats",
  "channels.searchPosts",
  "messages.searchGlobal",
  "channels.getChannelRecommendations",
] as const;
export type TelegramOperation = (typeof telegramOperations)[number];

const channelSchema = z.object({
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
    operations: z.array(z.enum(telegramOperations)).min(1),
    seedChannels: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .default([]),
    resultsPerQuery: z.number().int().min(1).max(50).default(10),
    maxItems: z.number().int().min(1).max(500).default(100),
    minParticipants: z.number().int().min(0).max(10_000_000).default(0),
    minDate: z.iso.date().optional(),
    maxDate: z.iso.date().optional(),
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

async function runWorker(
  command: "status" | "search" | "sample",
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Telegram worker превысил лимит времени 5 минут."));
    }, 300_000);
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
  operations: TelegramOperation[];
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

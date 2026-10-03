import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { telegramUsername } from "../../../shared/telegram-monitoring.js";
import { readTelegramMonitoringSettings } from "../../telegram-monitoring-settings.js";
import {
  channelSchema,
  monitoringPostSchema,
  runWorker,
  telegramRuntime,
} from "./client.js";
import { databasePath, requiredSecrets } from "./tool.js";

const publicChannel = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      /^\w{5,}$/.test(telegramUsername(value)) &&
      /^(?:@?[a-z0-9_]{5,}|https?:\/\/(?:www\.)?t\.me\/(?:s\/)?[a-z0-9_]{5,}\/?(?:\?[^\s]*)?)$/i.test(
        value,
      ),
    "Нужен публичный @username или URL канала t.me; ссылки на посты/инвайты не подходят.",
  );
export const researchTargetsShape = {
  channels: z.array(publicChannel).min(1).max(20),
  delaySeconds: z.number().min(3).max(30).default(4),
};
export const researchMessagesShape = {
  maxMessagesPerChannel: z.number().int().min(1).max(100).default(20),
  maxScannedPerChannel: z.number().int().min(1).max(5000).default(200),
  pageSize: z.number().int().min(10).max(100).default(100),
  beforeMessageIds: z.record(z.string(), z.string().regex(/^\d+$/)).default({}),
};
export const channelInfoInputSchema = z
  .object({
    ...researchTargetsShape,
    minParticipants: z.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export const pinnedInputSchema = z
  .object({
    ...researchTargetsShape,
    ...researchMessagesShape,
  })
  .strict()
  .refine(
    (v) => v.maxScannedPerChannel >= v.maxMessagesPerChannel,
    "maxScannedPerChannel должен быть не меньше maxMessagesPerChannel.",
  );
export const channelSearchShape = {
  ...researchTargetsShape,
  ...researchMessagesShape,
  query: z.string().trim().min(1).max(200),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  timeZone: z.string().trim().min(1).max(100).default("Europe/Belgrade"),
  afterMessageIds: z.record(z.string(), z.string().regex(/^\d+$/)).default({}),
  topicId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
  excludeReplies: z.boolean().default(false),
  excludeAdDisclosures: z.boolean().default(false),
  excludeKeywords: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .default([]),
};
export const channelSearchInputSchema = z
  .object(channelSearchShape)
  .strict()
  .refine(
    (v) => !v.startDate || !v.endDate || v.startDate <= v.endDate,
    "startDate не может быть позже endDate.",
  )
  .refine(
    (v) => v.maxScannedPerChannel >= v.maxMessagesPerChannel,
    "maxScannedPerChannel должен быть не меньше maxMessagesPerChannel.",
  );
const positiveMessageId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine(
    (v) => Number(v) <= 2_147_483_647,
    "ID вне диапазона Telegram int32.",
  );
export const topicsShape = {
  ...researchTargetsShape,
  query: z.string().trim().max(200).default(""),
  maxTopicsPerChannel: z.number().int().min(1).max(100).default(50),
  topicCursors: z
    .record(
      z.string(),
      z
        .object({
          offsetDate: z.iso.datetime({ offset: true }),
          offsetId: z.number().int().min(0).max(2_147_483_647),
          offsetTopic: z.number().int().min(0).max(2_147_483_647),
        })
        .strict(),
    )
    .default({}),
};
export const topicsInputSchema = z.object(topicsShape).strict();
export const contextMessagesShape = {
  ...researchTargetsShape,
  ...researchMessagesShape,
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  timeZone: z.string().trim().min(1).max(100).default("Europe/Belgrade"),
  afterMessageIds: z.record(z.string(), z.string().regex(/^\d+$/)).default({}),
};
export const topicPostsShape = {
  ...contextMessagesShape,
  channels: z.array(publicChannel).length(1),
  topicId: positiveMessageId,
};
export const commentsShape = {
  ...contextMessagesShape,
  channels: z.array(publicChannel).length(1),
  postId: positiveMessageId,
};
const contextBaseSchema = z.object(contextMessagesShape).strict();
function validateContext(
  v: z.output<typeof contextBaseSchema>,
  ctx: z.RefinementCtx,
) {
  if (v.startDate && v.endDate && v.startDate > v.endDate)
    ctx.addIssue({
      code: "custom",
      message: "startDate не может быть позже endDate.",
      path: ["startDate"],
    });
  if (v.maxScannedPerChannel < v.maxMessagesPerChannel)
    ctx.addIssue({
      code: "custom",
      message: "Недостаточный maxScannedPerChannel.",
      path: ["maxScannedPerChannel"],
    });
}
export const topicPostsInputSchema = z
  .object(topicPostsShape)
  .strict()
  .superRefine(validateContext);
export const linkedPostsInputSchema =
  contextBaseSchema.superRefine(validateContext);
export const commentsInputSchema = z
  .object(commentsShape)
  .strict()
  .superRefine(validateContext);
const billingSchema = z.object({
  perResultUsd: z.literal(0),
  paidStarsAllowed: z.literal(false),
  note: z.string(),
});
const responseShape = {
  ok: z.literal(true),
  requestCount: z.number().int().min(0),
  query: z.string().nullable(),
  warnings: z.array(z.string()),
  billing: billingSchema,
  range: z.object({
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    timeZone: z.string(),
  }),
};
export const channelInfoResponseSchema = z.object({
  ...responseShape,
  mode: z.literal("info"),
  channels: z.array(
    z.object({
      channel: channelSchema,
      description: z.string(),
      passesMinParticipants: z.boolean().nullable(),
      isForum: z.boolean(),
      latestPinnedMessageId: z.string().nullable(),
      linkedChat: z
        .object({
          id: z.string(),
          title: z.string(),
          username: z.string().nullable(),
          url: z.url().nullable(),
        })
        .nullable(),
    }),
  ),
});
export const channelMessagesResponseSchema = z.object({
  ...responseShape,
  mode: z.enum(["pinned", "search"]),
  channels: z.array(
    z.object({
      channel: channelSchema,
      scannedCount: z.number().int().min(0),
      returnedCount: z.number().int().min(0),
      filteredCount: z.number().int().min(0),
      filterBreakdown: z.record(z.string(), z.number().int().min(0)),
      totalMatches: z.number().int().min(0).nullable(),
      truncated: z.boolean(),
      nextBeforeMessageId: z.string().nullable(),
      posts: z.array(monitoringPostSchema),
    }),
  ),
});
export const topicsResponseSchema = z.object({
  ...responseShape,
  mode: z.literal("topics"),
  channels: z.array(
    z.object({
      channel: channelSchema,
      isForum: z.boolean(),
      totalTopics: z.number().int().nullable(),
      truncated: z.boolean(),
      nextCursor: topicsShape.topicCursors.unwrap().valueType.nullable(),
      topics: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          pinned: z.boolean(),
          closed: z.boolean(),
          hidden: z.boolean(),
          createdAt: z.string().nullable(),
          topMessageId: z.string(),
          lastMessageDate: z.string().nullable(),
          url: z.url(),
        }),
      ),
    }),
  ),
});
export const contextMessagesResponseSchema = z.object({
  ...responseShape,
  mode: z.enum(["topic_posts", "linked_posts", "comments"]),
  channels: z.array(
    channelMessagesResponseSchema.shape.channels.element.extend({
      sourceChannel: channelSchema,
      topicId: z.string().nullable(),
      discussionRootId: z.string().nullable(),
      status: z.enum(["available", "noLinkedChat", "linkedChatExcluded"]),
    }),
  ),
});

export const candidateInputSchema = z
  .object({
    candidates: z
      .array(
        z.object({
          id: z.string().regex(/^\d+$/).optional(),
          username: publicChannel,
        }),
      )
      .max(500),
  })
  .strict();

/** All stored communities, including hidden ones, participate in deduplication. */
export function filterTelegramCandidates(
  database: DatabaseSync,
  input: z.input<typeof candidateInputSchema>,
) {
  const { candidates } = candidateInputSchema.parse(input);
  const settings = readTelegramMonitoringSettings(database);
  const byId = new Map<string, string>(),
    byUsername = new Map<string, string>();
  const rows = database
    .prepare("SELECT id,data,overrides FROM entities WHERE type='Community'")
    .all() as Array<{ id: string; data: string; overrides: string }>;
  for (const row of rows) {
    // Index both original and overridden identifiers, so renamed/edited cards still match.
    for (const data of [JSON.parse(row.data), JSON.parse(row.overrides)]) {
      const known = data.knownIds || {};
      for (const id of [
        known.telegram,
        known.telegram_channel,
        String(data.externalId || "").replace(/^channel:/, ""),
      ]) {
        if (/^\d+$/.test(String(id || ""))) byId.set(String(id), row.id);
      }
      for (const value of [known.telegram_username, data.url]) {
        if (
          typeof value === "string" &&
          (value === known.telegram_username ||
            /^https?:\/\/(?:www\.)?t\.me\//i.test(value))
        ) {
          byUsername.set(telegramUsername(value), row.id);
        }
      }
    }
  }
  const seenIds = new Set<string>(),
    seenNames = new Set<string>();
  const fresh: typeof candidates = [];
  const skipped: Array<{
    id?: string;
    username: string;
    reason: string;
    communityId: string | null;
  }> = [];
  for (const candidate of candidates) {
    const username = telegramUsername(candidate.username);
    const communityId =
      (candidate.id && byId.get(candidate.id)) ||
      byUsername.get(username) ||
      null;
    const reason = communityId
      ? "alreadyStored"
      : settings.excludedChannels.includes(username)
        ? "excluded"
        : seenNames.has(username) || (candidate.id && seenIds.has(candidate.id))
          ? "duplicateCandidate"
          : null;
    if (reason) skipped.push({ ...candidate, username, reason, communityId });
    else fresh.push({ ...candidate, username });
    seenNames.add(username);
    if (candidate.id) seenIds.add(candidate.id);
  }
  return { candidates: fresh, skipped, requestCount: 0 };
}
export function getNewTelegramCandidates(
  input: z.input<typeof candidateInputSchema>,
) {
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    return filterTelegramCandidates(db, input);
  } finally {
    db.close();
  }
}

const researchInputs = {
  info: channelInfoInputSchema,
  pinned: pinnedInputSchema,
  search: channelSearchInputSchema,
  topics: topicsInputSchema,
  topic_posts: topicPostsInputSchema,
  linked_posts: linkedPostsInputSchema,
  comments: commentsInputSchema,
};
async function research(mode: keyof typeof researchInputs, input: unknown) {
  const args = researchInputs[mode].parse(input);
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  let settings;
  try {
    settings = readTelegramMonitoringSettings(db);
  } finally {
    db.close();
  }
  const requested = [...new Set(args.channels.map(telegramUsername))];
  const channels = requested.filter(
    (name) => !settings.excludedChannels.includes(name),
  );
  const skipped = requested.filter((name) =>
    settings.excludedChannels.includes(name),
  );
  const warnings = skipped.length
    ? [`Исключены настройками без Telegram RPC: ${skipped.join(", ")}`]
    : [];
  const searchArgs =
    mode === "search" ? channelSearchInputSchema.parse(input) : null;
  const contextArgs = ["topic_posts", "linked_posts", "comments"].includes(mode)
    ? { ...(args as z.output<typeof linkedPostsInputSchema>) }
    : null;
  const empty = {
    ok: true,
    mode,
    query:
      searchArgs?.query ||
      (mode === "topics" ? topicsInputSchema.parse(input).query : null) ||
      null,
    requestCount: 0,
    channels: [],
    warnings,
    range: {
      startDate: searchArgs?.startDate || contextArgs?.startDate || null,
      endDate: searchArgs?.endDate || contextArgs?.endDate || null,
      timeZone:
        searchArgs?.timeZone || contextArgs?.timeZone || "Europe/Belgrade",
    },
    billing: {
      perResultUsd: 0,
      paidStarsAllowed: false,
      note: "Запросов к Telegram не было.",
    },
  };
  const schema =
    mode === "info"
      ? channelInfoResponseSchema
      : mode === "topics"
        ? topicsResponseSchema
        : contextArgs
          ? contextMessagesResponseSchema
          : channelMessagesResponseSchema;
  if (!channels.length) return schema.parse(empty);
  const secrets = requiredSecrets();
  const runtime = telegramRuntime({
    apiId: secrets.TELEGRAM_API_ID!,
    apiHash: secrets.TELEGRAM_API_HASH!,
    pythonPath: secrets.TELEGRAM_PYTHON,
    sessionPath: secrets.TELEGRAM_SESSION_PATH,
  });
  const result = schema.parse(
    await runWorker("research", runtime, {
      ...args,
      mode,
      channels,
      ...(searchArgs
        ? {
            excludeReplies:
              settings.excludeReplies || searchArgs.excludeReplies,
            excludeAdDisclosures:
              settings.excludeAdDisclosures || searchArgs.excludeAdDisclosures,
            excludeKeywords: [
              ...new Set([
                ...settings.excludeKeywords,
                ...searchArgs.excludeKeywords,
              ]),
            ],
          }
        : {}),
      ...(contextArgs
        ? {
            // Explicit discussion research includes replies without changing feed preferences.
            excludeReplies: false,
            excludeKeywords: settings.excludeKeywords,
            excludeAdDisclosures: settings.excludeAdDisclosures,
          }
        : {}),
      excludedUsernames: settings.excludedChannels,
      excludedChannelIds: ["linked_posts", "comments"].includes(mode)
        ? excludedTelegramIds(settings.excludedChannels)
        : [],
    }),
  );
  return { ...result, warnings: [...warnings, ...result.warnings] };
}
export const getTelegramChannelInfo = (
  input: z.input<typeof channelInfoInputSchema>,
) => research("info", input);
export const getTelegramPinnedMessages = (
  input: z.input<typeof pinnedInputSchema>,
) => research("pinned", input);
export const searchTelegramChannelMessages = (
  input: z.input<typeof channelSearchInputSchema>,
) => research("search", input);
export const getTelegramGroupTopics = (
  input: z.input<typeof topicsInputSchema>,
) => research("topics", input);
export const getTelegramTopicPosts = (
  input: z.input<typeof topicPostsInputSchema>,
) => research("topic_posts", input);
export const getTelegramLinkedChatPosts = (
  input: z.input<typeof linkedPostsInputSchema>,
) => research("linked_posts", input);
export const getTelegramPostComments = (
  input: z.input<typeof commentsInputSchema>,
) => research("comments", input);

/** Block a linked group by its stored stable ID even when it has no current username. */
function excludedTelegramIds(names: string[]) {
  if (!names.length) return [];
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT data,overrides FROM entities WHERE type='Community'")
      .all() as Array<{ data: string; overrides: string }>;
    const ids = new Set<string>();
    for (const row of rows) {
      const original = JSON.parse(row.data),
        overrides = JSON.parse(row.overrides);
      const versions = [original, overrides];
      if (
        !versions.some((v) =>
          [
            v.knownIds?.telegram_username,
            /^https?:\/\/(?:www\.)?t\.me\//i.test(v.url || "") ? v.url : null,
          ].some(
            (v) => typeof v === "string" && names.includes(telegramUsername(v)),
          ),
        )
      )
        continue;
      for (const v of versions)
        for (const id of [
          v.knownIds?.telegram,
          v.knownIds?.telegram_channel,
          String(v.externalId || "").replace(/^channel:/, ""),
        ]) {
          if (/^\d+$/.test(String(id || ""))) ids.add(String(id));
        }
    }
    return [...ids];
  } finally {
    db.close();
  }
}

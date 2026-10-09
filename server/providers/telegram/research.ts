import { hasTelegramIdentity } from "@personal-radar/connectors/telegram";
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

import {
  researchTargetsShape,
  researchMessagesShape,
  channelInfoInputSchema,
  pinnedInputSchema,
  channelSearchShape,
  channelSearchInputSchema,
  topicsShape,
  topicsInputSchema,
  contextMessagesShape,
  topicPostsShape,
  commentsShape,
  topicPostsInputSchema,
  linkedPostsInputSchema,
  commentsInputSchema,
  channelInfoResponseSchema,
  channelMessagesResponseSchema,
  topicsResponseSchema,
  contextMessagesResponseSchema,
  candidateInputSchema,
} from "@personal-radar/connectors/telegram/research-contracts";
export {
  researchTargetsShape,
  researchMessagesShape,
  channelInfoInputSchema,
  pinnedInputSchema,
  channelSearchShape,
  channelSearchInputSchema,
  topicsShape,
  topicsInputSchema,
  contextMessagesShape,
  topicPostsShape,
  commentsShape,
  topicPostsInputSchema,
  linkedPostsInputSchema,
  commentsInputSchema,
  channelInfoResponseSchema,
  channelMessagesResponseSchema,
  topicsResponseSchema,
  contextMessagesResponseSchema,
  candidateInputSchema,
};
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
        : hasTelegramIdentity(candidate, { ids: seenIds, usernames: seenNames })
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

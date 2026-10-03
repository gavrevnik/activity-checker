import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeError } from "../server/secrets.js";
import { monitorTelegramChannelPosts } from "../server/providers/telegram/tool.js";
import {
  candidateInputSchema,
  channelInfoInputSchema,
  channelSearchShape,
  getNewTelegramCandidates,
  getTelegramChannelInfo,
  getTelegramPinnedMessages,
  researchMessagesShape,
  researchTargetsShape,
  searchTelegramChannelMessages,
  topicsShape,
  topicPostsShape,
  contextMessagesShape,
  commentsShape,
  getTelegramGroupTopics,
  getTelegramTopicPosts,
  getTelegramLinkedChatPosts,
  getTelegramPostComments,
} from "../server/providers/telegram/research.js";

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}
async function safeCall(callback: () => Promise<unknown> | unknown) {
  try {
    return response(await callback());
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: safeError(error) }],
    };
  }
}

export function registerTelegramResearchTools(
  server: McpServer,
  discovery: boolean,
) {
  server.registerTool(
    "telegram_search_channel_messages",
    {
      description:
        "Read-only server-side text search ONLY inside explicitly selected public channels/supergroups (messages.search). No global search, no Stars. Optional publication dates, topicId and per-channel pagination. Saved channel/content exclusions apply. Combine with a recent chronological sample; keyword hits alone are biased evidence.",
      inputSchema: channelSearchShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => searchTelegramChannelMessages(args)),
  );
  if (!discovery) return;
  server.registerTool(
    "telegram_group_topics",
    {
      description:
        "Read-only bounded forum topic list for explicit public groups. Returns titles, IDs, latest activity and pagination cursor; Telegram may include pins in addition to the requested page limit. Deduplicate topic IDs when merging pages. isForum=false is not an empty forum. Announce discovered topics and explain the goal-matching selection before reading it. No history scan, no join or import.",
      inputSchema: topicsShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => getTelegramGroupTopics(args)),
  );
  server.registerTool(
    "telegram_topic_posts",
    {
      description:
        "Read a bounded chronological sample ONLY from a selected forum topic in ONE group. Use topicId from telegram_group_topics. Non-General topics use messages.getReplies; General (1) filters bounded history, so a capped empty sample is inconclusive. Includes replies for explicit discussion research, preserving saved channel/keyword/ad exclusions. No settings changes, join or import.",
      inputSchema: topicPostsShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => getTelegramTopicPosts(args)),
  );
  server.registerTool(
    "telegram_linked_chat_posts",
    {
      description:
        "Read bounded recent conversation from a publication channel's verified linked discussion supergroup, not arbitrary private targets. Use when an otherwise relevant channel needs evidence of actual community interaction, language or openness to newcomers. Includes replies; saved channel/keyword/ad exclusions apply. No join/import. Inaccessible chats produce warnings; noLinkedChat and linkedChatExcluded are distinct statuses. Pagination keys use returned discussion username or numeric ID, not source channel.",
      inputSchema: contextMessagesShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => getTelegramLinkedChatPosts(args)),
  );
  server.registerTool(
    "telegram_post_comments",
    {
      description:
        "Read bounded comments for ONE publication channel post. Resolves and verifies the distinct discussion root using messages.getDiscussionMessage, then messages.getReplies; never assumes the source post ID equals the chat root. Useful for logistics, participation, co-rides or current clarifications. Includes replies, preserves channel/keyword/ad exclusions. No join/import or access bypass. Pagination keys use the returned discussion username/numeric ID.",
      inputSchema: commentsShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => getTelegramPostComments(args)),
  );
  server.registerTool(
    "telegram_discovery_filter_candidates",
    {
      description:
        "Local read-only deduplication BEFORE enrichment: exclude all already stored communities (including archived/filtered), saved channel exclusions and duplicate candidates by numeric Telegram ID/username. No Telegram RPC. Repeat for recommendations and after resolving canonical IDs.",
      inputSchema: candidateInputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => safeCall(() => getNewTelegramCandidates(args)),
  );
  server.registerTool(
    "telegram_channel_info",
    {
      description:
        "Read public channel/group description and authoritative participant count via channels.getFullChannel. Return passesMinParticipants=null when unknown (NOT a passed threshold), forum flag and linked discussion chat when available. No import. Inspect purpose and size before requesting pins/posts.",
      inputSchema: channelInfoInputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => getTelegramChannelInfo(args)),
  );
  server.registerTool(
    "telegram_channel_pinned_messages",
    {
      description:
        "Read current pins directly via messages.search + inputMessagesFilterPinned, WITHOUT any date bound or full-history scan. Includes old pins, rules/schedules/related links; content filters do not hide this evidence, but saved channel exclusions apply. Bounded pagination returns truncated/cursor. Read after description, before recent posts.",
      inputSchema: { ...researchTargetsShape, ...researchMessagesShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => getTelegramPinnedMessages(args)),
  );
  server.registerTool(
    "telegram_discovery_recent_posts",
    {
      description:
        "Read a bounded, chronological recent sample from explicit public candidate channels using the SAME monitoring worker and saved exclusions. Not random sampling. Read after description/pins to assess actual activity, language and relevance. No import. Combine with scoped keyword search if needed.",
      inputSchema: {
        ...researchTargetsShape,
        maxPostsPerChannel: z.number().int().min(1).max(100).default(20),
        maxScannedPerChannel: z.number().int().min(1).max(5000).default(200),
        startDate: z.iso.date().optional(),
        endDate: z.iso.date().optional(),
        timeZone: z.string().trim().min(1).max(100).default("Europe/Belgrade"),
        beforeMessageIds: z
          .record(z.string(), z.string().regex(/^\d+$/))
          .default({}),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => safeCall(() => monitorTelegramChannelPosts(args)),
  );
}

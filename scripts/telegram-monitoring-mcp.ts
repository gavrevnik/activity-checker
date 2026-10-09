import { registerTelegramBatchTools } from "./telegram-batch-tools.js";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getTelegramMonitoringChannels,
  getTelegramToolStatus,
  monitorTelegramChannelPosts,
} from "../server/providers/telegram/tool.js";
import { safeError } from "../server/secrets.js";
import { registerTelegramResearchTools } from "./telegram-research-tools.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const server = new McpServer({
  name: "activity-checker-telegram-monitoring",
  version: "0.1.0",
});

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: safeError(error) }],
  };
}

server.registerTool(
  "telegram_monitoring_status",
  {
    description:
      "Check the shared Telethon installation and user-session authorization without reading channel history.",
    inputSchema: {},
  },
  async () => {
    try {
      return response(await getTelegramToolStatus());
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "telegram_monitoring_channels",
  {
    description:
      "List public Telegram communities already stored in Activity Checker. This is a read-only SQLite lookup and performs no Telegram request.",
    inputSchema: {
      includeArchived: z.boolean().default(false),
      includeFiltered: z.boolean().default(false),
      includeExcluded: z
        .boolean()
        .default(false)
        .describe(
          "Include channels disabled in the saved monitoring settings; listing makes no Telegram requests.",
        ),
      limit: z.number().int().min(1).max(1000).default(200),
    },
  },
  async (args) => {
    try {
      const channels = getTelegramMonitoringChannels(args);
      return response({ count: channels.length, channels });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "telegram_monitoring_posts",
  {
    description:
      "Read paginated history from explicitly selected public channels via messages.getHistory. Date-only bounds are inclusive in timeZone. RPCs are sequential with a conservative randomized delay; Stars are never used. The result includes text, Telegram entities, hashtags, mentions, links, buttons, media metadata, forwards/replies, views, reactions and deterministic content signals.",
    inputSchema: {
      channels: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .default([])
        .describe("Public @usernames or t.me URLs."),
      communityIds: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .default([])
        .describe(
          "Activity Checker Community IDs returned by telegram_monitoring_channels.",
        ),
      allStoredChannels: z
        .boolean()
        .default(false)
        .describe(
          "Select every visible stored Telegram community; fails if there are more than 20 so callers can batch deliberately.",
        ),
      startDate: z.iso
        .date()
        .optional()
        .describe("Inclusive lower publication-date bound."),
      endDate: z.iso
        .date()
        .optional()
        .describe("Inclusive upper publication-date bound."),
      timeZone: z.string().trim().min(1).max(100).default("Europe/Belgrade"),
      maxPostsPerChannel: z.number().int().min(1).max(500).default(100),
      maxScannedPerChannel: z.number().int().min(1).max(5000).default(500),
      pageSize: z
        .number()
        .int()
        .min(10)
        .max(100)
        .default(100)
        .describe("Telegram history page size; 100 minimizes RPC count."),
      afterMessageIds: z
        .record(z.string(), z.string().regex(/^\d+$/))
        .default({})
        .describe(
          "Per-channel exclusive lower ID watermarks for incremental monitoring.",
        ),
      beforeMessageIds: z
        .record(z.string(), z.string().regex(/^\d+$/))
        .default({})
        .describe(
          "Per-channel exclusive pagination cursors for older history.",
        ),
      minViews: z.number().int().min(0).default(0),
      minTextLength: z.number().int().min(0).max(20_000).default(0),
      excludeForwards: z.boolean().default(false),
      excludeReplies: z
        .boolean()
        .optional()
        .describe(
          "Skip reply messages/comments, not posts that merely have comments.",
        ),
      excludeMediaOnly: z.boolean().default(false),
      excludeAdDisclosures: z
        .boolean()
        .optional()
        .describe(
          "Enabled by default: exclude explicit ad hashtags, disclosure phrases and erid identifiers. Prices/discounts alone are not ads. Custom keywords, hashtags and link domains can refine the deterministic filter.",
        ),
      excludeKeywords: z
        .array(z.string().trim().min(1).max(200))
        .max(100)
        .optional()
        .describe(
          "Case-insensitive literal substrings. Merged with the saved UI monitoring settings; those exclusions cannot be bypassed by an empty list. Disabled channels are skipped before any RPC.",
        ),
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
      delaySeconds: z
        .number()
        .min(3)
        .max(30)
        .default(4)
        .describe(
          "Base pause between MTProto RPCs; worker adds 0–1.5 seconds of jitter.",
        ),
    },
  },
  async (args) => {
    try {
      return response(await monitorTelegramChannelPosts(args));
    } catch (error) {
      return failure(error);
    }
  },
);

registerTelegramResearchTools(server, false);
registerTelegramBatchTools(server);

await server.connect(new StdioServerTransport());

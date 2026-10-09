import { registerTelegramBatchTools } from "./telegram-batch-tools.js";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  compactTelegramResult,
  executeTelegramTool,
  getTelegramQueryHistory,
  getTelegramToolStatus,
  markTelegramQueryHistory,
} from "../server/providers/telegram/tool.js";
import { safeError } from "../server/secrets.js";
import { registerTelegramResearchTools } from "./telegram-research-tools.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const server = new McpServer({
  name: "activity-checker-telegram-discovery",
  version: "0.1.0",
});

const common = {
  queries: z
    .array(z.string().trim().min(1).max(200))
    .max(30)
    .default([])
    .describe("Search hypotheses; batch up to 30 in one authorized session."),
  resultsPerQuery: z.number().int().min(1).max(50).default(10),
  maxItems: z.number().int().min(1).max(500).default(100),
  minParticipants: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(0)
    .describe(
      "Skip channels with a known smaller audience; unknown counts pass through.",
    ),
  store: z
    .boolean()
    .default(false)
    .describe("Write normalized public results into Activity Checker SQLite."),
};

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
  "telegram_status",
  {
    description:
      "Check Telethon installation and user-session authorization without performing a search.",
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
  "telegram_discovery_batch",
  {
    description:
      "Discover public Telegram channels by title/username and recommendations. Then filter existing candidates, read description/size, pins and recent posts, optionally scoped text search. Global post search stays disabled. Use store=true only for user-approved enrichment.",
    inputSchema: {
      ...common,
      operations: z
        .array(
          z.enum(["searchPublicChats", "channels.getChannelRecommendations"]),
        )
        .min(1)
        .max(2),
      seedChannels: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .default([])
        .describe(
          "Public @usernames or t.me URLs used for channel recommendations.",
        ),
    },
  },
  async (args) => {
    try {
      return response(compactTelegramResult(await executeTelegramTool(args)));
    } catch (error) {
      return failure(error);
    }
  },
);

function registerKeywordTool(
  name: string,
  operation: "searchPublicChats",
  description: string,
) {
  const keywordInput = {
    ...common,
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  };
  server.registerTool(
    name,
    { description, inputSchema: keywordInput },
    async (args) => {
      try {
        return response(
          compactTelegramResult(
            await executeTelegramTool({
              ...args,
              operations: [operation],
              seedChannels: [],
            }),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

registerKeywordTool(
  "telegram_search_public_chats",
  "searchPublicChats",
  "Find public Telegram channels and supergroups by title/username using contacts.search. Best first discovery step.",
);

// Intentionally not registered: channels.searchPosts and messages.searchGlobal.
// Only channel-scoped research is allowed; global/paid post search stays disabled.

server.registerTool(
  "telegram_channel_recommendations",
  {
    description:
      "Get similarly themed public channels for seed @usernames/t.me URLs. With no seeds, use recommendations based on channels joined by the authorized account.",
    inputSchema: {
      seedChannels: z
        .array(z.string().trim().min(1).max(200))
        .max(20)
        .default([]),
      resultsPerQuery: z.number().int().min(1).max(50).default(10),
      maxItems: z.number().int().min(1).max(500).default(100),
      minParticipants: z.number().int().min(0).max(10_000_000).default(0),
      store: z.boolean().default(false),
    },
  },
  async (args) => {
    try {
      return response(
        compactTelegramResult(
          await executeTelegramTool({
            queries: [],
            operations: ["channels.getChannelRecommendations"],
            ...args,
          }),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "telegram_query_history",
  {
    description:
      "Read Telegram query effectiveness history: returned, manually relevant and stored channel counts per keyword.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(200),
    },
  },
  async ({ limit }) => {
    try {
      return response({ rows: await getTelegramQueryHistory(limit) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "telegram_mark_query_relevance",
  {
    description:
      "After LLM review, mark which usernames from a recorded Telegram run were relevant and which were stored.",
    inputSchema: {
      runId: z.string().uuid(),
      relevantUsernames: z.array(z.string().trim().min(1)).max(500),
      storedUsernames: z.array(z.string().trim().min(1)).max(500).default([]),
      notes: z.string().max(2000).default(""),
    },
  },
  async (args) => {
    try {
      return response(await markTelegramQueryHistory(args));
    } catch (error) {
      return failure(error);
    }
  },
);

registerTelegramResearchTools(server, true);
registerTelegramBatchTools(server);

await server.connect(new StdioServerTransport());

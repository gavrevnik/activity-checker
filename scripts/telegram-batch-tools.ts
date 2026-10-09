import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicChannelSchema } from "@personal-radar/connectors/telegram";
import {
  executeTelegramBatchRead,
  getTelegramBatchResult,
  telegramBatchToolShape,
} from "../server/providers/telegram/batch.js";
import { safeError } from "../server/secrets.js";
export function registerTelegramBatchTools(server: McpServer) {
  const call = async (action: () => Promise<unknown>) => {
    try {
      const value = await action();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: safeError(error) }],
      };
    }
  };
  server.registerTool(
    "telegram_batch_read",
    {
      description:
        "Plan or execute one durable Telegram read request for up to 50 public channels/groups. Physical runs are sequential, capped at 20 and use one shared connection. Preserve requestId and cursors; results survive restarts. execute=false is default. Runtime journal only, no Community/Event/Knowledge import. Unknown dispatch is not retried unless the HUMAN authorizes retryUnknown=true. FloodWait blocks all requests in this scope. Existing 20-channel tools are unchanged.",
      inputSchema: telegramBatchToolShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) => call(() => executeTelegramBatchRead(args)),
  );
  server.registerTool(
    "telegram_batch_result",
    {
      description:
        "Read saved Telegram batch results without RPC. Optional source returns its saved channel info/topics/metadata in sourceResult. Follow nextOffset while hasUnread; hasMore means unfinished work. Only complete channels expose a watermark.",
      inputSchema: {
        requestId: z.uuid(),
        source: publicChannelSchema.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call(() => getTelegramBatchResult(args)),
  );
}

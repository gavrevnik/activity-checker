import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  botSendSchema,
  createOwnerBotService,
} from "../server/providers/telegram/bot.js";
import { safeError } from "../server/secrets.js";

export function registerTelegramBotTools(server: McpServer) {
  const bot = createOwnerBotService();
  server.registerTool(
    "telegram_bot_status",
    {
      description:
        "Read configured bot/owner recipient and credential storage without reading the token or making Telegram requests.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const value = bot.status();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    },
  );
  server.registerTool(
    "telegram_send_message_to_owner",
    {
      description:
        "Send plain text with clickable HTTP(S)/Telegram links ONLY to the configured owner's private chat via the configured bot. Requires explicit human instruction and confirmed=true. No arbitrary recipient, polling, scheduling, paid broadcasts or automatic retries. Use one stable requestId per message; replay returns the saved receipt without sending again. status=unknown is NOT success: stop and ask the human to check Telegram before any new send attempt. Max 4000 UTF-16 code units.",
      inputSchema: botSendSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const value = await bot.send(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value,
          ...(value.status === "sent" ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: safeError(error) }],
        };
      }
    },
  );
}

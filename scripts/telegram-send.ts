import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import {
  botSendSchema,
  createOwnerBotService,
} from "../server/providers/telegram/bot.js";
import { safeError } from "../server/secrets.js";

// Same guarded handler as the MCP tool; safe to resume the exact saved manifest.
const inputPath = process.argv[2] && resolve(process.argv[2]);
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
try {
  if (!inputPath || process.argv.length !== 3)
    throw new Error(
      "Usage: npm run telegram:send -- /absolute/path/messages.json",
    );
  const manifest = z
    .object({ messages: z.array(botSendSchema).min(1).max(50) })
    .strict()
    .parse(JSON.parse(readFileSync(inputPath, "utf8")));
  const ids = manifest.messages.map((m) => m.requestId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Каждой части нужен отдельный requestId.");
  const bot = createOwnerBotService();
  for (const message of manifest.messages) {
    const receipt = await bot.send(message);
    process.stdout.write(JSON.stringify(receipt) + "\n");
    if (receipt.status !== "sent")
      throw new Error(
        "Отправка остановлена. Проверьте сохранённый receipt; автоматического повтора нет.",
      );
  }
} catch (error) {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
}

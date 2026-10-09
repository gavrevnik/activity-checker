import { readFileSync } from "node:fs";
import {
  executeTelegramBatchRead,
  getTelegramBatchResult,
} from "../server/providers/telegram/batch.js";
import { safeError } from "../server/secrets.js";
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const result = process.argv.includes("--result")
    ? await getTelegramBatchResult(input)
    : await executeTelegramBatchRead(input);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
}

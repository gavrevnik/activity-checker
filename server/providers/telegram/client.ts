import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTelegramClient } from "@personal-radar/connectors/telegram/local";
import { LazyTelegramBatchStore } from "./batch-store.js";
import { telegramPolicy } from "@personal-radar/connectors/telegram";
export * from "@personal-radar/connectors/telegram";
const root = fileURLToPath(new URL("../../../", import.meta.url));
export const {
  telegramRuntime,
  runWorker,
  telegramStatus,
  executeTelegramBatch,
  sampleTelegramChannels,
  monitorTelegramChannels,
  authorizeTelegramInteractive,
} = createTelegramClient({
  root,
  batchStore: new LazyTelegramBatchStore(),
  scope: "activity-checker-telegram",
  gateDatabasePath: () =>
    resolve(
      process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite",
    ),
  pythonPath: resolve(root, ".venv-telegram/bin/python"),
  sessionPath: resolve(
    root,
    "../data/activity-checker/telegram/activity-checker",
  ),
  excludeKeywords: [...telegramPolicy.excludeKeywords],
});

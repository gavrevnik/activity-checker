import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTelegramClient } from "@personal-radar/connectors/telegram";
import monitoringFilters from "../../../data/telegram-monitoring-filters.json" with { type: "json" };
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
  pythonPath: resolve(root, ".venv-telegram/bin/python"),
  sessionPath: resolve(
    root,
    "../data/activity-checker/telegram/activity-checker",
  ),
  excludeKeywords: monitoringFilters.excludeKeywords,
});

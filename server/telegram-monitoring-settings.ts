import type { DatabaseSync } from "node:sqlite";
import {
  defaultTelegramMonitoringSettings,
  telegramMonitoringSettingsSchema,
  type TelegramMonitoringSettings,
} from "../shared/telegram-monitoring.js";

const key = "telegram-monitoring-settings";
export function readTelegramMonitoringSettings(
  db: DatabaseSync,
): TelegramMonitoringSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
    { value: string } | undefined;
  return row
    ? telegramMonitoringSettingsSchema.parse(JSON.parse(row.value))
    : defaultTelegramMonitoringSettings();
}
export function saveTelegramMonitoringSettings(
  db: DatabaseSync,
  input: unknown,
) {
  const settings = telegramMonitoringSettingsSchema.parse(input);
  db.prepare(
    "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(settings));
  return settings;
}

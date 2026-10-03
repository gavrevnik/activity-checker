import { z } from "zod";
import defaults from "../data/telegram-monitoring-filters.json";
import type { Entity } from "./model.js";

export function telegramUsername(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?t\.me\/(?:s\/)?/i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
}

const terms = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .transform((values) => [
    ...new Set(values.map((value) => value.toLowerCase())),
  ]);
export const telegramMonitoringSettingsSchema = z
  .object({
    excludeKeywords: terms,
    excludedChannels: z
      .array(z.string().trim().min(1).max(200))
      .max(1000)
      .transform((values) => [...new Set(values.map(telegramUsername))])
      .pipe(z.array(z.string().regex(/^[a-z0-9_]+$/))),
    excludeReplies: z.boolean(),
    excludeAdDisclosures: z.boolean(),
  })
  .strict();
export type TelegramMonitoringSettings = z.output<
  typeof telegramMonitoringSettingsSchema
>;
export const defaultTelegramMonitoringSettings =
  (): TelegramMonitoringSettings => ({
    excludeKeywords: [...defaults.excludeKeywords],
    excludedChannels: [
      "serbia_padel",
      "quizpleasebeg",
      "oneamerikanopadel_beograd",
      "serbia",
      "russkydombelgrad",
    ],
    excludeReplies: true,
    excludeAdDisclosures: true,
  });
export interface TelegramSettingsChannel {
  communityId: string;
  title: string;
  username: string;
}
export interface TelegramMonitoringSettingsView {
  settings: TelegramMonitoringSettings;
  channels: TelegramSettingsChannel[];
}
export function isTelegramCommunity(
  entity: Pick<Entity, "type" | "knownIds" | "tags" | "url">,
) {
  return (
    entity.type === "Community" &&
    (Boolean(
      entity.knownIds.telegram ||
      entity.knownIds.telegram_channel ||
      entity.knownIds.telegram_username,
    ) ||
      entity.tags.some((tag) => tag.toLowerCase() === "telegram") ||
      /^https?:\/\/(?:www\.)?t\.me\//i.test(entity.url))
  );
}
export function isTelegramScoreInput(value: string) {
  return value === "" || (/^\d{1,2}$/.test(value) && Number(value) <= 10);
}
export function matchesTelegramScore(score: number, minimum: string) {
  return !minimum || score >= Number(minimum);
}

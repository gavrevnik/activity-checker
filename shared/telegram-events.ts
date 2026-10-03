import { z } from "zod";
import type { PersonalState } from "./personal-state.js";

const eventDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const telegramEventSelectionSchema = z
  .object({
    communityId: z.string().min(1),
    postId: z.string().regex(/^\d+$/),
    activityKey: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    startAt: eventDate,
    endAt: z.union([eventDate, z.literal("")]).default(""),
    country: z.string().trim().min(1).max(100).default("RS"),
    city: z.string().trim().min(1).max(100).default("Belgrade"),
    venue: z.string().trim().max(1000).default(""),
    relevanceReason: z.string().trim().min(1).max(2000),
    validationNotes: z.string().trim().min(1).max(2000),
    relevanceScore: z.number().int().min(1).max(10),
  })
  .strict();
export type TelegramEventSelection = z.output<
  typeof telegramEventSelectionSchema
>;
export interface TelegramEvent extends TelegramEventSelection, PersonalState {
  id: string;
  channelTitle: string;
  channelUsername: string;
  channelTags: string[];
  postTitle: string;
  fullText: string;
  preview: string;
  publishedAt: string | null;
  postUrl: string;
  postHashtags: string[];
  createdAt: string;
  updatedAt: string;
}
export const telegramChannelReviewSchema = z
  .object({
    communityId: z.string().min(1),
    lowRelevance: z.boolean(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export interface TelegramChannelReview extends z.output<
  typeof telegramChannelReviewSchema
> {
  title: string;
  username: string;
  scannedCount: number;
  returnedCount: number;
  acceptedCount: number;
  truncated: boolean;
}
export interface TelegramEventReview {
  id: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  profileFingerprint: string;
  channels: TelegramChannelReview[];
  warnings: string[];
}
export interface TelegramEventsView {
  events: TelegramEvent[];
  review: TelegramEventReview | null;
}

// Telegram has no title field: use the first non-empty line, not an invented API field.
export function telegramPostTitle(text: string) {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 500) || "Публикация Telegram"
  );
}
export function telegramPostPreview(text: string) {
  const segmenter = new Intl.Segmenter("ru", { granularity: "sentence" });
  return [...segmenter.segment(text)]
    .slice(0, 5)
    .map((part) => part.segment)
    .join("")
    .trim();
}

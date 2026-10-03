import { z } from "zod";
import type { Entity, EntityReaction } from "./model.js";

export const eventPreferenceSummaryInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    summary: z.string().trim().min(1).max(5000),
    evidence: z
      .array(
        z
          .object({
            eventId: z.string().min(1),
            fingerprint: z.string().length(64),
            conclusion: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type EventPreferenceSummaryInput = z.input<
  typeof eventPreferenceSummaryInputSchema
>;

export const eventScoresInputSchema = z
  .object({
    expectedSummaryRevision: z.number().int().min(0),
    scores: z
      .array(
        z
          .object({
            eventId: z.string().min(1),
            fingerprint: z.string().length(64),
            score: z.number().min(0).max(10),
            reason: z.string().trim().min(1).max(2000),
            tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type EventScoresInput = z.input<typeof eventScoresInputSchema>;

export interface EventPreferenceSummary {
  summary: string;
  revision: number;
  updatedAt: string;
}
export interface EventPreferenceSnapshot {
  title: string;
  description: string;
  category: string;
  tags: string[];
  languages: string[];
  audience: Entity["audience"];
  startAt: string;
  venue: string;
  url: string;
  reaction: EntityReaction;
  favorite: boolean;
  notes: string;
  dislikeReason?: string;
}
export interface EventPreferencePending {
  eventId: string;
  fingerprint: string;
  origin: "active" | "past_events_archive" | "telegram_events";
  snapshot: EventPreferenceSnapshot;
  previousConclusion: string | null;
}
export interface EventPreferenceEvidence {
  eventId: string;
  fingerprint: string;
  snapshot: EventPreferenceSnapshot;
  conclusion: string;
  summaryRevision: number;
  reviewedAt: string;
}
export interface EventScoreCandidate {
  event: Entity;
  fingerprint: string;
}

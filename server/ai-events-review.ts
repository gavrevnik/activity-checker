import type { Express } from "express";
import { z } from "zod";
import {
  eventPreferenceSummaryInputSchema,
  eventScoresInputSchema,
  type EventPreferenceEvidence,
  type EventPreferencePending,
  type EventPreferenceSnapshot,
  type EventPreferenceSummary,
  type EventPreferenceSummaryInput,
  type EventScoreCandidate,
  type EventScoresInput,
} from "../shared/ai-events-review.js";
import { entitySchema, type Entity } from "../shared/model.js";
import { localDay } from "../shared/dates.js";
import { digest } from "./normalize.js";
import type { Store } from "./store.js";
import type { TelegramEvent } from "../shared/telegram-events.js";

// Feedback fingerprints deliberately exclude AI metadata and storage location.
// Scoring or archiving a card must not make its user feedback look new.
function feedbackSnapshot(event: Entity): EventPreferenceSnapshot {
  return {
    title: event.title,
    description: event.description,
    category: event.category,
    tags: event.tags,
    languages: event.languages,
    audience: event.audience,
    startAt: event.startAt,
    venue: event.venue,
    url: event.url,
    reaction: event.reaction || "",
    favorite: !!event.favorite,
    notes: event.notes || "",
    // Omit empty reasons to keep fingerprints of previously reviewed feedback stable.
    ...(event.dislikeReason ? { dislikeReason: event.dislikeReason } : {}),
  };
}

function scoreFingerprint(event: Entity, profileFingerprint: string) {
  return digest({
    profileFingerprint,
    data: entitySchema.parse(eventCanonicalInput(event)),
    reaction: event.reaction,
    skipped: !!event.skipped,
    favorite: event.favorite,
    archived: event.archived,
    filtered: event.filtered,
    notes: event.notes,
  });
}

function eventCanonicalInput(event: Entity) {
  return Object.fromEntries(
    Object.keys(entitySchema.shape).map((key) => [
      key,
      event[key as keyof Entity],
    ]),
  );
}

export class AiEventsReview {
  constructor(private store: Store) {}

  summary(): EventPreferenceSummary {
    return this.store.db
      .prepare(
        "SELECT summary,revision,updatedAt FROM ai_event_preference_summary WHERE id='main'",
      )
      .get() as unknown as EventPreferenceSummary;
  }

  evidence(): EventPreferenceEvidence[] {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM ai_event_preference_evidence ORDER BY summaryRevision,eventId",
      )
      .all() as unknown as Array<
      Omit<EventPreferenceEvidence, "snapshot"> & { snapshot: string }
    >;
    return rows.map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
  }

  pending(): EventPreferencePending[] {
    const reviewed = new Map(
      this.evidence().map((item) => [item.eventId, item]),
    );
    const events = this.store.db
      .prepare("SELECT * FROM entities WHERE type='Event'")
      .all()
      .map((row) => ({
        event: this.store.rowEntity(row),
        origin: "active" as const,
      }));
    const activeIds = new Set(events.map(({ event }) => event.id));
    const archived = this.store.db
      .prepare("SELECT entityId,snapshot FROM past_events_archive")
      .all() as Array<{ entityId: string; snapshot: string }>;
    const allEvents: Array<{
      event: Entity;
      origin: EventPreferencePending["origin"];
    }> = [
      ...events,
      ...archived
        .filter((row) => !activeIds.has(row.entityId))
        .map((row) => ({
          event: { ...JSON.parse(row.snapshot), id: row.entityId } as Entity,
          origin: "past_events_archive" as const,
        })),
    ];
    const feedback = allEvents.flatMap(({ event, origin }) => {
      if (event.demo) return [];
      const previous = reviewed.get(event.id);
      if (!event.reaction && !event.favorite && !previous) return [];
      const snapshot = feedbackSnapshot(event);
      const fingerprint = digest(snapshot);
      if (previous?.fingerprint === fingerprint) return [];
      return [
        {
          eventId: event.id,
          fingerprint,
          origin,
          snapshot,
          previousConclusion: previous?.conclusion ?? null,
        },
      ];
    });
    // Feedback from selected Telegram occurrences informs the same summary,
    // while scoring candidates remain canonical Event cards only.
    const telegram = this.store.db
      .prepare(
        "SELECT id,data,reaction,favorite,dislikeReason FROM telegram_events",
      )
      .all() as Array<{
      id: string;
      data: string;
      reaction: Entity["reaction"];
      favorite: number;
      dislikeReason: string;
    }>;
    for (const row of telegram) {
      const eventId = "telegram:" + row.id;
      const previous = reviewed.get(eventId);
      if (!row.reaction && !row.favorite && !previous) continue;
      const event = JSON.parse(row.data) as TelegramEvent;
      const snapshot: EventPreferenceSnapshot = {
        title: event.title,
        description: event.fullText,
        category: "Telegram",
        tags: event.postHashtags,
        languages: [],
        audience: "all",
        startAt: event.startAt,
        venue: event.venue,
        url: event.postUrl,
        reaction: row.reaction,
        favorite: !!row.favorite,
        notes: "",
        ...(row.dislikeReason ? { dislikeReason: row.dislikeReason } : {}),
      };
      const fingerprint = digest(snapshot);
      if (previous?.fingerprint !== fingerprint)
        feedback.push({
          eventId,
          fingerprint,
          origin: "telegram_events",
          snapshot,
          previousConclusion: previous?.conclusion ?? null,
        });
    }
    return feedback.sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  saveSummary(input: EventPreferenceSummaryInput) {
    const data = eventPreferenceSummaryInputSchema.parse(input);
    return this.store.transaction(() => {
      if (this.summary().revision !== data.expectedRevision)
        throw new Error("Summary изменился; перечитайте контекст оценки");
      const pending = new Map(
        this.pending().map((item) => [item.eventId, item]),
      );
      const ids = new Set<string>();
      const revision = data.expectedRevision + 1;
      const updatedAt = new Date().toISOString();
      for (const item of data.evidence) {
        if (ids.has(item.eventId)) throw new Error("ID события повторяется");
        ids.add(item.eventId);
        const current = pending.get(item.eventId);
        if (!current || current.fingerprint !== item.fingerprint)
          throw new Error(
            "Разметка события изменилась; перечитайте контекст оценки",
          );
        this.store.db
          .prepare(
            "INSERT INTO ai_event_preference_evidence (eventId,fingerprint,snapshot,conclusion,summaryRevision,reviewedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(eventId) DO UPDATE SET fingerprint=excluded.fingerprint,snapshot=excluded.snapshot,conclusion=excluded.conclusion,summaryRevision=excluded.summaryRevision,reviewedAt=excluded.reviewedAt",
          )
          .run(
            item.eventId,
            item.fingerprint,
            JSON.stringify(current.snapshot),
            item.conclusion,
            revision,
            updatedAt,
          );
      }
      this.store.db
        .prepare(
          "UPDATE ai_event_preference_summary SET summary=?,revision=?,updatedAt=? WHERE id='main'",
        )
        .run(data.summary, revision, updatedAt);
      return this.summary();
    });
  }

  candidates(scopeId = "belgrade", now = new Date()): EventScoreCandidate[] {
    const scope = this.store.scope(scopeId);
    const today = localDay(now, scope.timezone);
    const profileFingerprint = digest(this.store.profile());
    return this.store
      .entities()
      .filter(
        (event) =>
          event.type === "Event" &&
          !event.demo &&
          !event.archived &&
          !event.reaction &&
          !event.skipped &&
          !event.favorite &&
          event.country === scope.country &&
          (!scope.city || event.city === scope.city) &&
          !!event.startAt &&
          (event.startAt.length === 10
            ? event.startAt >= today
            : Date.parse(event.startAt) >= now.valueOf()),
      )
      .map((event) => ({
        event,
        fingerprint: scoreFingerprint(event, profileFingerprint),
      }));
  }

  context(scopeId = "belgrade") {
    return {
      scope: this.store.scope(scopeId),
      now: new Date().toISOString(),
      profile: this.store.profile(),
      summary: this.summary(),
      reviewedEvidence: this.evidence(),
      pendingFeedback: this.pending(),
      candidates: this.candidates(scopeId),
    };
  }

  saveScores(input: EventScoresInput, scopeId = "belgrade") {
    const data = eventScoresInputSchema.parse(input);
    return this.store.transaction(() => {
      if (this.summary().revision !== data.expectedSummaryRevision)
        throw new Error("Summary изменился; перечитайте контекст оценки");
      if (this.pending().length)
        throw new Error(
          "Сначала обновите summary по новой пользовательской разметке",
        );
      const candidates = new Map(
        this.candidates(scopeId).map((item) => [item.event.id, item]),
      );
      const ids = new Set<string>();
      return data.scores.map((item) => {
        if (ids.has(item.eventId)) throw new Error("ID события повторяется");
        ids.add(item.eventId);
        const current = candidates.get(item.eventId);
        if (!current || current.fingerprint !== item.fingerprint)
          throw new Error(
            "Карточка изменилась или уже не подходит для оценки; перечитайте контекст",
          );
        return this.store.editEntity(item.eventId, {
          ...eventCanonicalInput(current.event),
          type: "Event",
          title: current.event.title,
          aiScore: item.score,
          aiReason: item.reason,
          aiTags: item.tags,
          aiProcessedAt: new Date().toISOString(),
          aiDecision: item.score >= 7 ? "recommended" : "unknown",
        });
      });
    });
  }
}

export function registerAiEventsReviewApi(app: Express, store: Store) {
  const review = new AiEventsReview(store);
  const scopeQuery = z.object({
    scopeId: z.string().min(1).default("belgrade"),
  });
  app.get("/api/ai-events-review/context", (req, res) =>
    res.json(review.context(scopeQuery.parse(req.query).scopeId)),
  );
  app.put("/api/ai-events-review/summary", (req, res) =>
    res.json(review.saveSummary(req.body)),
  );
  app.post("/api/ai-events-review/scores", (req, res) =>
    res.json(review.saveScores(req.body, scopeQuery.parse(req.query).scopeId)),
  );
}

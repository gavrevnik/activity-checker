import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createApi } from "../server/api.js";
import { AiEventsReview } from "../server/ai-events-review.js";
import { Store } from "../server/store.js";
import { entitySchema, type EntityInput } from "../shared/model.js";

let store: Store;
let review: AiEventsReview;
beforeEach(() => {
  store = new Store(":memory:");
  review = new AiEventsReview(store);
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
});

function add(title: string, extra: Partial<EntityInput> = {}) {
  store.ingest(store.source("source-manual"), [
    {
      entity: { type: "Event", title, startAt: "2099-10-01", ...extra },
      raw: { externalId: title, url: "", rawText: "", payload: {} },
    },
  ]);
  return store
    .entities({ includeFiltered: true })
    .find((event) => event.title === title)!;
}

function incorporate() {
  return review.saveSummary({
    expectedRevision: review.summary().revision,
    summary:
      "Нравятся камерные концерты; по отдельным дизлайкам причина пока не ясна.",
    evidence: review.pending().map((item) => ({
      eventId: item.eventId,
      fingerprint: item.fingerprint,
      conclusion: `${item.snapshot.title}: реакция ${item.snapshot.reaction || "звёздочка"}`,
    })),
  });
}

describe("AI event preferences and scoring", () => {
  it("persists neutral skips through refresh/archive without teaching preferences or remaining scoreable", () => {
    const event = add("Skipped event");
    const candidate = review
      .candidates()
      .find((item) => item.event.id === event.id)!;
    expect(review.candidates().some((item) => item.event.id === event.id)).toBe(
      true,
    );
    store.setState(event.id, { skipped: true, skipReason: "дубль" });
    expect(() =>
      review.saveScores({
        expectedSummaryRevision: 0,
        scores: [
          {
            eventId: event.id,
            fingerprint: candidate.fingerprint,
            score: 8,
            reason: "Stale score",
          },
        ],
      }),
    ).toThrow("Карточка изменилась или уже не подходит для оценки");
    expect(review.candidates().some((item) => item.event.id === event.id)).toBe(
      false,
    );
    expect(review.pending()).toEqual([]);
    add("Skipped event");
    expect(store.entitySummary(event.id)).toMatchObject({
      skipped: true,
      skipReason: "дубль",
      reaction: "",
    });
    store.setState(event.id, { skipReason: "Не сейчас" });
    expect(review.pending()).toEqual([]);
    store.setState(event.id, { reaction: "dislike", dislikeReason: "Music" });
    expect(store.entitySummary(event.id).skipped).toBe(false);
    incorporate();
    store.setState(event.id, { skipped: true });
    expect(review.pending()).toHaveLength(1); // Withdraw the old dislike, do not learn a new dislike.
    expect(review.pending()[0].snapshot.reaction).toBe("");
    expect(review.pending()[0].snapshot).not.toHaveProperty("skipReason");
    incorporate();
    store.setState(event.id, { skipReason: "дубль" });
    expect(review.pending()).toEqual([]);
    store.archivePastEvents("belgrade", "2100-01-01");
    expect(review.pending()).toEqual([]);
    const archived = store.db
      .prepare("SELECT snapshot FROM past_events_archive WHERE entityId=?")
      .get(event.id) as { snapshot: string };
    expect(JSON.parse(archived.snapshot)).toMatchObject({
      skipped: true,
      skipReason: "дубль",
    });
  });
  it("stores an explicit refusal separately, preserves it through sync/archive, and revisits edited/cleared reasons", () => {
    const event = add("Feedback event", { startAt: "2000-01-01" });
    store.setState(event.id, {
      reaction: "dislike",
      favorite: true,
      notes: "Keep my note",
    });
    incorporate();
    const before = review.evidence()[0].fingerprint;
    store.setState(event.id, { dislikeReason: "Too late in the evening" });
    expect(store.entitySummary(event.id)).toMatchObject({
      reaction: "dislike",
      favorite: true,
      notes: "Keep my note",
      dislikeReason: "Too late in the evening",
    });
    expect(review.pending()[0].fingerprint).not.toBe(before);
    expect(review.pending()[0].snapshot.dislikeReason).toBe(
      "Too late in the evening",
    );
    incorporate();
    add("Feedback event", { startAt: "2000-01-01" }); // Provider refresh keeps personal feedback.
    expect(store.entitySummary(event.id).dislikeReason).toBe(
      "Too late in the evening",
    );
    expect(review.pending()).toEqual([]);
    store.setState(event.id, {
      dislikeReason: "Not interested in this format",
    });
    expect(review.pending()).toHaveLength(1);
    incorporate();
    store.setState(event.id, { dislikeReason: "" });
    expect(review.pending()[0].snapshot.dislikeReason).toBeUndefined();
    incorporate();
    store.setState(event.id, { dislikeReason: "Too expensive" });
    incorporate();
    store.archivePastEvents("belgrade", "2026-10-02");
    expect(review.pending()).toEqual([]);
    expect(review.evidence()[0].snapshot.dislikeReason).toBe("Too expensive");
    const archived = store.db
      .prepare("SELECT snapshot FROM past_events_archive WHERE entityId=?")
      .get(event.id) as { snapshot: string };
    expect(JSON.parse(archived.snapshot).dislikeReason).toBe("Too expensive");
  });

  it("includes Telegram occurrence feedback in summary with namespaced IDs, not in scoring candidates", () => {
    const channel = add("Telegram feedback channel", {
      type: "Community",
      url: "https://t.me/testclub",
    });
    const id = "tg-feedback";
    store.db
      .prepare(
        "INSERT INTO telegram_events (id,communityId,channelUsername,postId,activityKey,country,city,startAt,data,createdAt,updatedAt,reaction,dislikeReason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        channel.id,
        "testclub",
        "12",
        "one",
        "RS",
        "Belgrade",
        "2000-01-01",
        JSON.stringify({
          title: "Telegram activity",
          fullText: "Full original announcement",
          postHashtags: ["music"],
          startAt: "2000-01-01",
          venue: "Club",
          postUrl: "https://t.me/testclub/12",
        }),
        "initial",
        "initial",
        "dislike",
        "Too crowded",
      );
    expect(review.pending()).toMatchObject([
      {
        eventId: "telegram:" + id,
        origin: "telegram_events",
        snapshot: {
          reaction: "dislike",
          dislikeReason: "Too crowded",
          url: "https://t.me/testclub/12",
        },
      },
    ]);
    expect(review.candidates().some(({ event }) => event.id === id)).toBe(
      false,
    );
    incorporate();
    expect(review.pending()).toEqual([]);
    store.db
      .prepare("UPDATE telegram_events SET dislikeReason='' WHERE id=?")
      .run(id);
    expect(review.pending()).toHaveLength(1);
    incorporate();
    store.db
      .prepare("UPDATE telegram_events SET reaction='' WHERE id=?")
      .run(id);
    expect(review.pending()[0].snapshot.reaction).toBe("");
  });

  it("keeps archived user feedback and revisits changed or cleared signals", () => {
    const past = add("Past liked concert", { startAt: "2000-01-01" });
    const liked = add("Liked", { category: "Музыка" });
    const starred = add("Starred");
    const conflict = add("Mixed signals");
    store.setState(past.id, { reaction: "like" });
    store.setState(liked.id, { reaction: "like" });
    store.setState(starred.id, { favorite: true });
    store.setState(conflict.id, { reaction: "dislike", favorite: true });
    const place = add("Place", { type: "Place", startAt: "" });
    store.setState(place.id, { favorite: true });
    const demo = add("Demo", { demo: true });
    store.setState(demo.id, { reaction: "like" });

    store.archivePastEvents("belgrade", "2026-10-02");
    expect(review.pending()).toHaveLength(4);
    expect(
      review.pending().find((item) => item.eventId === past.id),
    ).toMatchObject({
      origin: "past_events_archive",
      snapshot: { reaction: "like" },
    });
    expect(review.summary()).toMatchObject({ summary: "", revision: 0 });
    expect(incorporate().revision).toBe(1);
    expect(review.evidence()).toHaveLength(4);
    expect(review.pending()).toEqual([]);

    store.setState(liked.id, { reaction: "dislike", notes: "Too crowded" });
    store.setState(starred.id, { favorite: false });
    expect(review.pending()).toHaveLength(2);
    expect(
      review.pending().find((item) => item.eventId === starred.id),
    ).toMatchObject({
      snapshot: { reaction: "", favorite: false },
      previousConclusion: "Starred: реакция звёздочка",
    });
    incorporate();
    expect(review.pending()).toEqual([]);
    expect(
      review.evidence().find((item) => item.eventId === liked.id)?.snapshot
        .notes,
    ).toBe("Too crowded");

    store.archivePastEvents("belgrade", "2100-01-01");
    expect(review.pending()).toEqual([]);
    expect(review.evidence()).toHaveLength(4);
  });

  it("only selects future unmarked visible events, using local days for date-only cards", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    add("Past moment today", { startAt: "2026-10-02T10:00:00Z" });
    add("Future moment today", { startAt: "2026-10-02T14:00:00Z" });
    add("Today without time", { startAt: "2026-10-02" });
    add("Yesterday", { startAt: "2026-10-01" });
    add("Undated", { startAt: "" });
    add("Other city", { city: "Niš" });
    add("Demo", { demo: true });
    add("Place", { type: "Place" });
    const rated = add("Rated");
    store.setState(rated.id, { reaction: "dislike" });
    const starred = add("Starred");
    store.setState(starred.id, { favorite: true });
    const archived = add("Manual archive");
    store.setState(archived.id, { archived: true });
    add("Filtered tribute", { tags: ["test"] });
    add("Existing AI score", { aiScore: 5 });
    const now = new Date("2026-10-02T12:00:00Z");
    expect(
      review
        .candidates("belgrade", now)
        .map(({ event }) => event.title)
        .sort(),
    ).toEqual([
      "Existing AI score",
      "Future moment today",
      "Today without time",
    ]);
    expect(
      review.candidates("serbia", now).map(({ event }) => event.title),
    ).toContain("Other city");
    const afterMidnight = new Date("2026-10-02T22:30:00Z");
    expect(
      review
        .candidates("belgrade", afterMidnight)
        .map(({ event }) => event.title),
    ).not.toContain("Today without time");
  });

  it("saves summary and reviewed IDs atomically and rejects stale or duplicate evidence", () => {
    const a = add("A"),
      b = add("B");
    store.setState(a.id, { reaction: "like" });
    store.setState(b.id, { reaction: "dislike" });
    const pending = review.pending();
    const evidence = pending.map((item) => ({
      eventId: item.eventId,
      fingerprint: item.fingerprint,
      conclusion: "Weak signal",
    }));
    evidence[1].fingerprint = "0".repeat(64);
    expect(() =>
      review.saveSummary({ expectedRevision: 0, summary: "Draft", evidence }),
    ).toThrow("Разметка события изменилась");
    expect(review.summary().revision).toBe(0);
    expect(review.evidence()).toEqual([]);
    const item = {
      eventId: pending[0].eventId,
      fingerprint: pending[0].fingerprint,
      conclusion: "Signal",
    };
    expect(() =>
      review.saveSummary({
        expectedRevision: 0,
        summary: "Draft",
        evidence: [item, item],
      }),
    ).toThrow("ID события повторяется");
    expect(review.evidence()).toEqual([]);
    incorporate();
    expect(() =>
      review.saveSummary({
        expectedRevision: 0,
        summary: "Stale",
        evidence: [item],
      }),
    ).toThrow("Summary изменился");
  });

  it("requires fresh feedback and guards the entire score batch against concurrent changes", () => {
    const liked = add("User liked");
    store.setState(liked.id, { reaction: "like" });
    const a = add("A"),
      b = add("B");
    const scores = review.candidates().map((item) => ({
      eventId: item.event.id,
      fingerprint: item.fingerprint,
      score: 8.5,
      reason: "Strong match",
    }));
    expect(() =>
      review.saveScores({ expectedSummaryRevision: 0, scores }),
    ).toThrow("Сначала обновите summary");
    incorporate();
    expect(() =>
      review.saveScores({ expectedSummaryRevision: 0, scores }),
    ).toThrow("Summary изменился");
    const aScore = scores.find((item) => item.eventId === a.id)!;
    const bScore = scores.find((item) => item.eventId === b.id)!;
    expect(() =>
      review.saveScores({
        expectedSummaryRevision: 1,
        scores: [aScore, { ...bScore, fingerprint: "0".repeat(64) }],
      }),
    ).toThrow("Карточка изменилась");
    expect(store.entity(a.id).aiScore).toBeNull();
    expect(store.entity(b.id).aiScore).toBeNull();
    expect(
      review
        .saveScores({ expectedSummaryRevision: 1, scores })
        .every((event) => event.aiScore === 8.5),
    ).toBe(true);
    expect(review.pending()).toEqual([]);
    expect(store.entity(liked.id).reaction).toBe("like");
    expect(store.entity(a.id)).toMatchObject({
      aiDecision: "recommended",
      aiReason: "Strong match",
    });

    const stale = review.candidates().map((item) => ({
      eventId: item.event.id,
      fingerprint: item.fingerprint,
      score: 6,
      reason: "Reconsidered",
    }));
    const { updatedAt: _updatedAt, ...profile } = store.profile();
    store.saveProfile({ ...profile, summary: "Changed preferences" });
    expect(() =>
      review.saveScores({ expectedSummaryRevision: 1, scores: stale }),
    ).toThrow("Карточка изменилась");
  });

  it("preserves scored AI metadata across source sync and validates the 0–10 scale", () => {
    const event = add("Concert");
    const candidate = review.candidates()[0];
    const payload = {
      expectedSummaryRevision: 0,
      scores: [
        {
          eventId: event.id,
          fingerprint: candidate.fingerprint,
          score: 9.2,
          reason: "Favourite artist",
          tags: ["music"],
        },
      ],
    };
    expect(() =>
      review.saveScores({
        ...payload,
        scores: [{ ...payload.scores[0], score: 11 }],
      }),
    ).toThrow();
    review.saveScores(payload);
    store.ingest(store.source("source-manual"), [
      {
        entity: {
          type: "Event",
          title: "Concert",
          startAt: "2099-10-01",
          description: "Provider update",
        },
        raw: { externalId: "Concert", url: "", rawText: "", payload: {} },
      },
    ]);
    expect(store.entity(event.id)).toMatchObject({
      aiScore: 9.2,
      aiReason: "Favourite artist",
      description: "Provider update",
    });
    expect(
      entitySchema.safeParse({ type: "Event", title: "Invalid", aiScore: 91 })
        .success,
    ).toBe(false);
  });

  it("migrates all legacy scores, overrides and archive snapshots exactly once", () => {
    const legacy = add("Legacy"),
      empty = add("Unscored");
    store.db
      .prepare(
        "UPDATE entities SET data=json_set(data,'$.aiScore',10),overrides=? WHERE id=?",
      )
      .run('{"aiScore":91}', legacy.id);
    store.db
      .prepare(
        "INSERT INTO past_events_archive (entityId,title,country,city,startAt,snapshot,archivedAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "archived-legacy",
        "Archived",
        "RS",
        "Belgrade",
        "2000-01-01",
        JSON.stringify({ ...legacy, aiScore: 50 }),
        "2026-10-02",
      );
    store.db
      .prepare("DELETE FROM migrations WHERE name=?")
      .run("020_ai_score_ten_point_scale.sql");
    store.migrate();
    expect(store.entity(legacy.id).aiScore).toBe(1);
    expect(store.entity(empty.id).aiScore).toBeNull();
    expect(
      JSON.parse(
        String(
          store.db
            .prepare("SELECT overrides FROM entities WHERE id=?")
            .get(legacy.id)!.overrides,
        ),
      ).aiScore,
    ).toBe(9.1);
    expect(
      JSON.parse(
        String(
          store.db
            .prepare(
              "SELECT snapshot FROM past_events_archive WHERE entityId=?",
            )
            .get("archived-legacy")!.snapshot,
        ),
      ).aiScore,
    ).toBe(5);
    store.migrate();
    expect(store.entity(legacy.id).aiScore).toBe(1);
  });

  it("runs the API workflow: archive, refresh feedback summary, then score future cards", async () => {
    const past = add("Past HTTP liked", { startAt: "2000-01-01" });
    store.setState(past.id, { reaction: "like" });
    const future = add("Future HTTP");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    server.on("request", createApi(store, address.port));
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api${path}`,
        {
          method,
          headers:
            method === "GET" ? {} : { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify(body),
        },
      );
      return { status: response.status, body: (await response.json()) as any };
    };
    try {
      const archived = await request("/entities/archive-past", "POST", {
        scopeId: "belgrade",
      });
      expect(archived.body.archived).toBe(1);
      const initial = await request("/ai-events-review/context");
      expect(initial.status).toBe(200);
      expect(initial.body.pendingFeedback[0].origin).toBe(
        "past_events_archive",
      );
      expect(initial.body.candidates.map((item: any) => item.event.id)).toEqual(
        [future.id],
      );
      const candidate = initial.body.candidates[0];
      const scores = [
        {
          eventId: future.id,
          fingerprint: candidate.fingerprint,
          score: 9,
          reason: "Strong match",
        },
      ];
      expect(
        (
          await request("/ai-events-review/scores", "POST", {
            expectedSummaryRevision: 0,
            scores,
          })
        ).status,
      ).toBe(400);
      const summary = await request("/ai-events-review/summary", "PUT", {
        expectedRevision: 0,
        summary: "Нравятся камерные концерты.",
        evidence: initial.body.pendingFeedback.map((item: any) => ({
          eventId: item.eventId,
          fingerprint: item.fingerprint,
          conclusion: "Положительный сигнал концерта",
        })),
      });
      expect(summary.status).toBe(200);
      expect(summary.body.revision).toBe(1);
      const saved = await request("/ai-events-review/scores", "POST", {
        expectedSummaryRevision: 1,
        scores,
      });
      expect(saved.status).toBe(200);
      expect(saved.body[0].aiScore).toBe(9);
      const final = await request("/ai-events-review/context");
      expect(final.body.pendingFeedback).toEqual([]);
      expect(final.body.reviewedEvidence[0].eventId).toBe(past.id);
      expect(final.body.candidates[0].event.aiScore).toBe(9);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

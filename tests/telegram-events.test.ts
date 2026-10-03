import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.js";
import { AiEventsReview } from "../server/ai-events-review.js";
import { TelegramEvents } from "../server/telegram-events.js";
import { telegramEventsReviewInputSchema } from "../server/telegram-events.js";
import { telegramPostPreview } from "../shared/telegram-events.js";
import { saveTelegramMonitoringSettings } from "../server/telegram-monitoring-settings.js";
import { defaultTelegramMonitoringSettings } from "../shared/telegram-monitoring.js";

let store: Store;
let events: TelegramEvents;
let communityId: string;
beforeEach(() => {
  store = new Store(":memory:");
  events = new TelegramEvents(store);
  store.ingest(store.source("source-manual"), [
    {
      entity: {
        type: "Community",
        title: "Test club",
        url: "https://t.me/testclub",
        tags: ["telegram", "social"],
      },
      raw: { externalId: "testclub", url: "", rawText: "", payload: {} },
    },
  ]);
  communityId = store
    .entities({ includeFiltered: true })
    .find((item) => item.title === "Test club")!.id;
});
afterEach(() => store.close());
const now = new Date("2026-10-02T10:00:00Z");
it("keeps a neutral skip and its separate reason across reimport without recommendation feedback", () => {
  events.save(input(), now);
  const id = events.view("belgrade", now).events[0].id;
  events.setState(id, { skipped: true, skipReason: "  дубль  " });
  events.save(input(), now);
  expect(events.get(id)).toMatchObject({
    skipped: true,
    skipReason: "дубль",
    reaction: "",
    dislikeReason: "",
  });
  expect(new AiEventsReview(store).pending()).toEqual([]);
  events.setState(id, { skipReason: "позже" });
  expect(new AiEventsReview(store).pending()).toEqual([]);
  events.setState(id, { reaction: "like" });
  expect(events.get(id)).toMatchObject({ skipped: false, reaction: "like" });
  expect(new AiEventsReview(store).pending()).toHaveLength(1);
  events.setState(id, { skipped: true });
  expect(new AiEventsReview(store).pending()).toEqual([]);
  events.setState(id, { skipped: false });
  expect(events.get(id)).toMatchObject({
    skipped: false,
    reaction: "",
    skipReason: "позже",
  });
});
it("hides an excluded channel and its saved events without deleting history or personal state", () => {
  events.save(input(), now);
  const event = events.view("belgrade", now).events[0];
  events.setState(event.id, {
    reaction: "dislike",
    dislikeReason: "Не подходит",
    favorite: true,
  });
  saveTelegramMonitoringSettings(store.db, {
    ...defaultTelegramMonitoringSettings(),
    excludedChannels: ["@TESTCLUB"],
  });
  expect(events.view("belgrade", now).events).toEqual([]);
  expect(events.view("belgrade", now).review!.channels).toEqual([]);
  expect(events.get(event.id)).toMatchObject({
    reaction: "dislike",
    dislikeReason: "Не подходит",
    favorite: true,
  });
  const historical = store.db
    .prepare("SELECT data FROM telegram_event_reviews")
    .get() as { data: string };
  expect(JSON.parse(historical.data).channels).toHaveLength(1);
  saveTelegramMonitoringSettings(store.db, {
    ...defaultTelegramMonitoringSettings(),
    excludedChannels: [],
  });
  expect(events.view("belgrade", now).events).toHaveLength(1);
  expect(events.view("belgrade", now).review!.channels).toHaveLength(1);
});
it("hides an archived channel's saved events and restores them when unarchived", () => {
  events.save(input(), now);
  store.setState(communityId, { archived: true });
  expect(events.view("belgrade", now).events).toEqual([]);
  expect(events.view("belgrade", now).review!.channels).toEqual([]);
  store.setState(communityId, { archived: false });
  expect(events.view("belgrade", now).events).toHaveLength(1);
});
it("rejects a stale snapshot selection when its channel has since been disabled", () => {
  saveTelegramMonitoringSettings(store.db, {
    ...defaultTelegramMonitoringSettings(),
    excludedChannels: ["testclub"],
  });
  expect(() => events.save(input(), now)).toThrow(/Канал исключён/);
  expect(events.view("belgrade", now).events).toHaveLength(0);
});
it("rejects a source post matching a newly saved pre-LLM literal keyword", () => {
  saveTelegramMonitoringSettings(store.db, {
    ...defaultTelegramMonitoringSettings(),
    excludeKeywords: ["BEGINNERS WELCOME"],
  });
  expect(() => events.save(input(), now)).toThrow(/ключевым словом/);
  expect(events.view("belgrade", now).events).toHaveLength(0);
});
it("does not show deleted channels in the current review while retaining the historical audit", () => {
  const review = input();
  review.selections = [];
  events.save(review, now);
  store.db.prepare("DELETE FROM entities WHERE id=?").run(communityId);
  expect(events.view("belgrade", now).review!.channels).toEqual([]);
  const historical = store.db
    .prepare("SELECT data FROM telegram_event_reviews")
    .get() as { data: string };
  expect(JSON.parse(historical.data).channels).toHaveLength(1);
});
function input() {
  return telegramEventsReviewInputSchema.parse({
    startDate: "2026-09-30",
    endDate: "2026-10-02",
    expectedProfileFingerprint: events.profileFingerprint(),
    selections: [
      {
        communityId,
        postId: "12",
        activityKey: "game-oct3",
        title: "Game meetup",
        startAt: "2026-10-03T14:00:00+02:00",
        relevanceScore: 9,
        relevanceReason: "Small interactive group",
        validationNotes: "Time and venue are in original announcement",
      },
    ],
    channelReviews: [
      { communityId, lowRelevance: false, reason: "One relevant announcement" },
    ],
    monitoring: {
      ok: true,
      requestCount: 2,
      range: {
        startDate: "2026-09-29T22:00:00Z",
        endDate: "2026-10-02T21:59:59Z",
        timeZone: "Europe/Belgrade",
      },
      warnings: [],
      billing: { perResultUsd: 0, paidStarsAllowed: false, note: "Read-only" },
      channels: [
        {
          channel: {
            id: "1",
            title: "Test club",
            username: "testclub",
            url: "https://t.me/testclub",
            broadcast: true,
            megagroup: false,
            verified: false,
          },
          scannedCount: 1,
          returnedCount: 1,
          filteredCount: 0,
          filterBreakdown: {},
          truncated: false,
          nextBeforeMessageId: null,
          posts: [
            {
              id: "12",
              text: "Game meetup. Meet new people. Beginners welcome! Fourth sentence. Fifth sentence. Sixth sentence.",
              date: "2026-10-01T10:00:00Z",
              editDate: null,
              url: "https://t.me/testclub/12",
              authorSignature: null,
              senderId: null,
              viaBotId: null,
              groupedId: null,
              replyToMessageId: null,
              replyToTopId: null,
              isPost: true,
              isForwarded: false,
              isReply: false,
              isPinned: false,
              isSilent: false,
              noForwards: false,
              views: 100,
              forwards: 2,
              replyCount: 7,
              reactionCount: 0,
              reactions: [],
              media: null,
              entities: [],
              hashtags: [],
              mentions: [],
              links: [],
              buttons: [],
              forward: null,
              restrictionReasons: [],
              signals: {
                hasText: true,
                hasMedia: false,
                hasExternalLink: false,
                hasTelegramLink: false,
                hasPrice: false,
                hasPromoLanguage: false,
                hasAdDisclosure: false,
              },
            },
          ],
        },
      ],
    },
  });
}
describe("Separate reviewed Telegram events", () => {
  it("keeps independent favorite and mutually exclusive like/dislike states", () => {
    events.save(input(), now);
    const event = events.view("belgrade", now).events[0];
    expect(event).toMatchObject({ favorite: false, reaction: "" });
    expect(events.setState(event.id, { reaction: "like" })).toMatchObject({
      reaction: "like",
      favorite: false,
    });
    expect(events.setState(event.id, { favorite: true })).toMatchObject({
      reaction: "like",
      favorite: true,
    });
    expect(events.setState(event.id, { reaction: "dislike" })).toMatchObject({
      reaction: "dislike",
      favorite: true,
    });
    expect(events.setState(event.id, { reaction: "" })).toMatchObject({
      reaction: "",
      favorite: true,
    });
    expect(events.setState(event.id, { favorite: false })).toMatchObject({
      reaction: "",
      favorite: false,
    });
    expect(store.entitySummary(communityId)).toMatchObject({
      favorite: false,
      reaction: "",
    });
    expect(events.view("belgrade", now).events).toHaveLength(1); // No deletion or archival by rating.
  });
  it("preserves personal state when an event is re-reviewed and updates only its source content", () => {
    events.save(input(), now);
    const id = events.view("belgrade", now).events[0].id;
    events.setState(id, {
      favorite: true,
      reaction: "dislike",
      dislikeReason: "  Too crowded  ",
    });
    const updated = input();
    updated.selections[0].title = "New title";
    events.save(updated, now);
    expect(new TelegramEvents(store).get(id)).toMatchObject({
      title: "New title",
      favorite: true,
      reaction: "dislike",
      dislikeReason: "Too crowded",
    });
    expect(events.setState(id, { dislikeReason: "" })).toMatchObject({
      dislikeReason: "",
      reaction: "dislike",
      favorite: true,
    });
  });
  it("rates each occurrence independently even when they originate from the same Telegram post", () => {
    const args = input();
    args.selections.push({ ...args.selections[0], activityKey: "second-slot" });
    events.save(args, now);
    const [first, second] = events.view("belgrade", now).events;
    events.setState(first.id, { reaction: "like", favorite: true });
    expect(events.get(second.id)).toMatchObject({
      reaction: "",
      favorite: false,
    });
    events.setState(second.id, { reaction: "dislike" });
    expect(events.get(first.id)).toMatchObject({
      reaction: "like",
      favorite: true,
    });
  });
  it("strictly rejects invalid state without changing stored ratings", () => {
    events.save(input(), now);
    const id = events.view("belgrade", now).events[0].id;
    events.setState(id, { reaction: "like" });
    for (const bad of [
      {},
      { reaction: "love" },
      { favorite: 1 },
      { reaction: "dislike", title: "Overwrite" },
      { archived: true },
      { dislikeReason: 1 },
      { dislikeReason: "x".repeat(2001) },
    ])
      expect(() => events.setState(id, bad)).toThrow();
    expect(events.get(id)).toMatchObject({ reaction: "like", favorite: false });
    expect(() => events.setState("missing", { favorite: true })).toThrow(
      /не найдено/,
    );
  });
  it("allows confirmation by ID after an event expires", () => {
    events.save(input(), now);
    const id = events.view("belgrade", now).events[0].id;
    events.setState(id, { favorite: true });
    expect(events.view("belgrade", new Date("2099-01-01")).events).toEqual([]);
    expect(events.get(id).favorite).toBe(true);
  });
  it("stores provenance, five-sentence preview and channel tags without adding a general Event", () => {
    const before = store.entities({ includeFiltered: true }).length;
    expect(events.save(input(), now).savedCount).toBe(1);
    const view = events.view("belgrade", now);
    expect(view.events[0]).toMatchObject({
      title: "Game meetup",
      channelTitle: "Test club",
      channelTags: ["telegram", "social"],
      postUrl: "https://t.me/testclub/12",
    });
    expect(view.events[0].preview).not.toContain("Sixth");
    expect(view.events[0].fullText).toContain("Sixth");
    expect(view.review?.channels[0].acceptedCount).toBe(1);
    expect(store.entities({ includeFiltered: true })).toHaveLength(before);
    events.save(input(), now);
    expect(events.view("belgrade", now).events).toHaveLength(1);
  });
  it("rejects stale profile, replies, ads, unknown posts and past events atomically", () => {
    for (const change of [
      (args: ReturnType<typeof input>) => {
        args.expectedProfileFingerprint = "stale";
      },
      (args: ReturnType<typeof input>) => {
        args.monitoring.channels[0].posts[0].isReply = true;
      },
      (args: ReturnType<typeof input>) => {
        args.monitoring.channels[0].posts[0].signals.hasAdDisclosure = true;
      },
      (args: ReturnType<typeof input>) => {
        args.selections[0].postId = "999";
      },
      (args: ReturnType<typeof input>) => {
        args.selections[0].startAt = "2026-10-01";
      },
      (args: ReturnType<typeof input>) => {
        args.selections[0].startAt = "2026-10-02T09:00:00Z";
      },
    ]) {
      const args = input();
      change(args);
      expect(() => events.save(args, now)).toThrow();
    }
    expect(events.view("belgrade", now).events).toEqual([]);
    expect(events.view("belgrade", now).review).toBeNull();
    const args = input();
    args.selections.push({
      ...args.selections[0],
      activityKey: "other",
      postId: "999",
    });
    expect(() => events.save(args, now)).toThrow();
    expect(events.view("belgrade", now).events).toEqual([]);
  });
  it("separates scopes, keeps date-only today and hides elapsed events without deleting them", () => {
    const args = input();
    args.selections[0].startAt = "2026-10-02";
    events.save(args, now);
    expect(events.view("belgrade", now).events).toHaveLength(1);
    expect(
      events.view("belgrade", new Date("2026-10-02T22:01:00Z")).events,
    ).toEqual([]);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM telegram_events").get()?.n,
    ).toBe(1);
    const other = input();
    other.selections[0].city = "Novi Sad";
    other.selections[0].activityKey = "novisad";
    events.save(other, now);
    expect(events.view("serbia", now).events).toHaveLength(2);
    expect(events.view("belgrade", now).events).toHaveLength(1);
  });
  it("uses real sentence boundaries for at most five sentences", () => {
    expect(telegramPostPreview("Один. Два! Три? Четыре. Пять. Шесть.")).toBe(
      "Один. Два! Три? Четыре. Пять.",
    );
  });
});

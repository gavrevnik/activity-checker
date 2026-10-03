import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  telegramEventSelectionSchema,
  telegramChannelReviewSchema,
  telegramPostTitle,
  telegramPostPreview,
  type TelegramEvent,
  type TelegramEventReview,
  type TelegramEventsView,
} from "../shared/telegram-events.js";
import { telegramMonitoringResponseSchema } from "./providers/telegram/client.js";
import { digest } from "./normalize.js";
import { localDay } from "../shared/dates.js";
import type { Store } from "./store.js";
import { userProfileSchema } from "../shared/model.js";
import { telegramUsername } from "../shared/telegram-monitoring.js";
import {
  readTelegramMonitoringSettings,
  saveTelegramMonitoringSettings,
} from "./telegram-monitoring-settings.js";
import { listTelegramMonitoringChannels } from "./providers/telegram/tool.js";
import {
  normalizePersonalStatePatch,
  personalStatePatchSchema,
} from "../shared/personal-state.js";

interface TelegramEventRow {
  data: string;
  createdAt: string;
  updatedAt: string;
  favorite: number;
  reaction: TelegramEvent["reaction"];
  dislikeReason: string;
  skipped: number;
  skipReason: string;
}

export const telegramEventsReviewInputSchema = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    expectedProfileFingerprint: z.string().min(1),
    monitoring: telegramMonitoringResponseSchema,
    selections: z.array(telegramEventSelectionSchema).max(500),
    channelReviews: z.array(telegramChannelReviewSchema).max(1000),
  })
  .strict();

function isPast(
  event: { startAt: string; endAt: string },
  timeZone: string,
  now: Date,
) {
  const last = event.endAt || event.startAt;
  return last.length === 10
    ? last < localDay(now, timeZone)
    : new Date(last).valueOf() < now.valueOf();
}

export class TelegramEvents {
  constructor(private store: Store) {}
  private hydrate(
    row: TelegramEventRow,
    community?: ReturnType<Store["entitySummary"]>,
  ): TelegramEvent {
    const event = JSON.parse(row.data) as TelegramEvent;
    const source = community || this.store.entitySummary(event.communityId);
    return {
      ...event,
      channelTitle: source.title,
      channelTags: source.tags,
      preview: telegramPostPreview(event.fullText),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      favorite: Boolean(row.favorite),
      reaction: row.reaction,
      dislikeReason: row.dislikeReason,
      skipped: !!row.skipped,
      skipReason: row.skipReason,
    };
  }
  get(id: string): TelegramEvent {
    const row = this.store.db
      .prepare(
        "SELECT data,createdAt,updatedAt,favorite,reaction,dislikeReason,skipped,skipReason FROM telegram_events WHERE id=?",
      )
      .get(id) as TelegramEventRow | undefined;
    if (!row) throw new Error("Telegram-мероприятие не найдено.");
    return this.hydrate(row);
  }
  setState(id: string, input: unknown): TelegramEvent {
    const state = normalizePersonalStatePatch(
      personalStatePatchSchema.parse(input),
    );
    return this.store.transaction(() => {
      this.get(id);
      const fields: string[] = [];
      const values: Array<string | number> = [];
      if (state.favorite !== undefined) {
        fields.push("favorite=?");
        values.push(Number(state.favorite));
      }
      if (state.reaction !== undefined) {
        fields.push("reaction=?");
        values.push(state.reaction);
      }
      if (state.dislikeReason !== undefined) {
        fields.push("dislikeReason=?");
        values.push(state.dislikeReason);
      }
      if (state.skipped !== undefined) {
        fields.push("skipped=?");
        values.push(Number(state.skipped));
      }
      if (state.skipReason !== undefined) {
        fields.push("skipReason=?");
        values.push(state.skipReason);
      }
      this.store.db
        .prepare(
          `UPDATE telegram_events SET ${fields.join(",")},updatedAt=? WHERE id=?`,
        )
        .run(...values, new Date().toISOString(), id);
      return this.get(id);
    });
  }
  profileFingerprint() {
    const { updatedAt: _updatedAt, ...profile } = this.store.profile();
    return digest(userProfileSchema.parse(profile));
  }
  view(scopeId: string, now = new Date()): TelegramEventsView {
    const scope = this.store.scope(scopeId);
    const excludedChannels = new Set(
      readTelegramMonitoringSettings(this.store.db).excludedChannels,
    );
    const communities = new Map<string, ReturnType<Store["entitySummary"]>>();
    const rows = this.store.db
      .prepare(
        "SELECT data,createdAt,updatedAt,favorite,reaction,dislikeReason,skipped,skipReason FROM telegram_events WHERE country=? AND (?='' OR city=?) ORDER BY startAt,id",
      )
      .all(
        scope.country,
        scope.city || "",
        scope.city || "",
      ) as unknown as TelegramEventRow[];
    const events = rows
      .map((row) => {
        const event = JSON.parse(row.data) as TelegramEvent;
        let community = communities.get(event.communityId);
        if (!community) {
          community = this.store.entitySummary(event.communityId);
          communities.set(event.communityId, community);
        }
        return this.hydrate(row, community);
      })
      .filter(
        (event) =>
          !excludedChannels.has(telegramUsername(event.channelUsername)) &&
          !communities.get(event.communityId)!.archived &&
          !isPast(event, scope.timezone, now),
      );
    const latest = this.store.db
      .prepare(
        "SELECT data FROM telegram_event_reviews ORDER BY createdAt DESC,rowid DESC LIMIT 1",
      )
      .get() as { data: string } | undefined;
    const review: TelegramEventReview | null = latest
      ? JSON.parse(latest.data)
      : null;
    // Keep the historical audit, but only surface active, enabled channels.
    if (review)
      review.channels = review.channels.filter(
        (channel) =>
          !excludedChannels.has(telegramUsername(channel.username)) &&
          Boolean(
            this.store.db
              .prepare("SELECT 1 FROM entities WHERE id=? AND archived=0")
              .get(channel.communityId),
          ),
      );
    return { events, review };
  }
  save(
    input: z.input<typeof telegramEventsReviewInputSchema>,
    now = new Date(),
  ) {
    const args = telegramEventsReviewInputSchema.parse(input);
    if (args.expectedProfileFingerprint !== this.profileFingerprint())
      throw new Error("Профиль изменился: повторите анализ Telegram-постов.");
    if (args.startDate > args.endDate)
      throw new Error("Неверный период мониторинга.");
    const settings = readTelegramMonitoringSettings(this.store.db);
    const channelByUsername = new Map(
      args.monitoring.channels.map((item) => [
        item.channel.username.toLowerCase(),
        item,
      ]),
    );
    const findChannel = (communityId: string) => {
      const community = this.store.entitySummary(communityId);
      if (community.type !== "Community")
        throw new Error("Источник должен быть сообществом.");
      const username = (
        community.knownIds.telegram_username ||
        new URL(community.url).pathname.split("/")[1] ||
        ""
      ).replace(/^@/, "");
      const channel = channelByUsername.get(username.toLowerCase());
      if (!channel)
        throw new Error(`Нет monitoring-снимка для ${community.title}`);
      return { community, channel };
    };
    const seen = new Set<string>();
    const events = args.selections.map((selection) => {
      const { community, channel } = findChannel(selection.communityId);
      if (
        settings.excludedChannels.includes(
          telegramUsername(channel.channel.username),
        )
      )
        throw new Error(
          "Канал исключён настройками мониторинга: повторите сбор без него.",
        );
      const post = channel.posts.find((item) => item.id === selection.postId);
      if (!post)
        throw new Error(
          `Пост ${selection.postId} отсутствует в monitoring-снимке.`,
        );
      if (
        !post.date ||
        localDay(post.date, args.monitoring.range.timeZone) < args.startDate ||
        localDay(post.date, args.monitoring.range.timeZone) > args.endDate
      )
        throw new Error("Публикация не входит в проверяемый период.");
      if (post.isReply || post.signals.hasAdDisclosure || !post.text.trim())
        throw new Error(
          "Ответы, явная реклама и пустые публикации не могут стать мероприятием.",
        );
      if (
        settings.excludeKeywords.some((term) =>
          post.text.toLowerCase().includes(term.toLowerCase()),
        )
      )
        throw new Error(
          "Пост исключён ключевым словом в настройках мониторинга.",
        );
      if (isPast(selection, "Europe/Belgrade", now))
        throw new Error(
          "Прошедшее мероприятие не добавляется в активную вкладку.",
        );
      if (selection.endAt) {
        const earlier =
          selection.endAt.length === 10 || selection.startAt.length === 10
            ? localDay(selection.endAt, "Europe/Belgrade") <
              localDay(selection.startAt, "Europe/Belgrade")
            : new Date(selection.endAt).valueOf() <
              new Date(selection.startAt).valueOf();
        if (earlier) throw new Error("Окончание раньше начала мероприятия.");
      }
      const id = digest([
        channel.channel.username.toLowerCase(),
        post.id,
        selection.activityKey,
      ]);
      if (seen.has(id))
        throw new Error("Повтор мероприятия в одном review batch.");
      seen.add(id);
      return {
        ...selection,
        id,
        channelTitle: community.title,
        channelUsername: channel.channel.username,
        channelTags: community.tags,
        postTitle: telegramPostTitle(post.text),
        fullText: post.text,
        preview: telegramPostPreview(post.text),
        publishedAt: post.date,
        postUrl: post.url || "",
        postHashtags: post.hashtags,
      };
    });
    const channels = args.channelReviews.map((review) => {
      const { community, channel } = findChannel(review.communityId);
      return {
        ...review,
        title: community.title,
        username: channel.channel.username,
        scannedCount: channel.scannedCount,
        returnedCount: channel.returnedCount,
        acceptedCount: events.filter(
          (event) => event.communityId === review.communityId,
        ).length,
        truncated: channel.truncated,
      };
    });
    if (
      new Set(channels.map((channel) => channel.communityId)).size !==
      channels.length
    )
      throw new Error("Повтор обзора канала.");
    const stamp = now.toISOString();
    const review: TelegramEventReview = {
      id: randomUUID(),
      startDate: args.startDate,
      endDate: args.endDate,
      createdAt: stamp,
      profileFingerprint: args.expectedProfileFingerprint,
      channels,
      warnings: args.monitoring.warnings,
    };
    this.store.transaction(() => {
      const save = this.store.db.prepare(`INSERT INTO telegram_events
        (id,communityId,channelUsername,postId,activityKey,country,city,startAt,endAt,data,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,
        country=excluded.country,city=excluded.city,startAt=excluded.startAt,endAt=excluded.endAt,updatedAt=excluded.updatedAt`);
      for (const event of events)
        save.run(
          event.id,
          event.communityId,
          event.channelUsername.toLowerCase(),
          event.postId,
          event.activityKey,
          event.country,
          event.city,
          event.startAt,
          event.endAt,
          JSON.stringify(event),
          stamp,
          stamp,
        );
      this.store.db
        .prepare("INSERT INTO telegram_event_reviews VALUES (?,?,?,?,?)")
        .run(
          review.id,
          args.startDate,
          args.endDate,
          JSON.stringify(review),
          stamp,
        );
    });
    return { savedCount: events.length, review };
  }
}

export function registerTelegramEventsApi(app: Express, store: Store) {
  const events = new TelegramEvents(store);
  app.get("/api/telegram-events/count", (req, res) =>
    res.json({
      count: events.view(
        z
          .string()
          .min(1)
          .parse(req.query.scopeId || "belgrade"),
      ).events.length,
    }),
  );
  app.get("/api/telegram-monitoring/settings", (_req, res) =>
    res.json({
      settings: readTelegramMonitoringSettings(store.db),
      channels: listTelegramMonitoringChannels(store.db, {
        includeFiltered: true,
        includeExcluded: true,
        limit: 1000,
      }),
    }),
  );
  app.put("/api/telegram-monitoring/settings", (req, res) =>
    res.json({
      settings: saveTelegramMonitoringSettings(store.db, req.body),
    }),
  );
  app.get("/api/telegram-events", (req, res) =>
    res.json(
      events.view(
        z
          .string()
          .min(1)
          .parse(req.query.scopeId || "belgrade"),
      ),
    ),
  );
  app.get("/api/telegram-events/review-context", (_req, res) =>
    res.json({
      profile: store.profile(),
      profileFingerprint: events.profileFingerprint(),
    }),
  );
  app.post("/api/telegram-events/review", (req, res) =>
    res.json(events.save(req.body)),
  );
  app.get("/api/telegram-events/:id", (req, res) =>
    res.json(events.get(req.params.id)),
  );
  app.patch("/api/telegram-events/:id", (req, res) =>
    res.json(events.setState(req.params.id, req.body)),
  );
}

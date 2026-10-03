import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Store } from "../server/store";
import {
  estimatedTelegramRequests,
  normalizeTelegramQueries,
  telegramDiscoveryOperations,
  telegramMonitoringResponseSchema,
  type TelegramSearchResult,
} from "../server/providers/telegram/client";
import {
  telegram,
  telegramRawItem,
} from "../server/providers/telegram/provider";

const channel: TelegramSearchResult = {
  kind: "channel",
  operations: ["searchPublicChats"],
  matchedQueries: ["squash belgrade"],
  channel: {
    id: "123",
    title: "Belgrade Squash",
    username: "belgradesquash",
    url: "https://t.me/belgradesquash",
    broadcast: true,
    megagroup: false,
    verified: false,
    participantsCount: 420,
  },
};

describe("Telegram MTProto tool", () => {
  it.skipIf(!existsSync(".venv-telegram/bin/python"))("checks offline worker defaults, filters, timezone and pagination", () => {
    expect(execFileSync(".venv-telegram/bin/python", ["tests/telegram-monitoring-worker.py"], {encoding: "utf8"})).toContain("passed");
  });
  it("deduplicates hypotheses and estimates sequential RPC calls", () => {
    expect(
      normalizeTelegramQueries([
        "squash belgrade",
        " squash belgrade ",
        "сквош белград",
      ]),
    ).toEqual(["squash belgrade", "сквош белград"]);
    expect(
      estimatedTelegramRequests({
        queryCount: 3,
        operations: ["searchPublicChats", "channels.getChannelRecommendations"],
        seedCount: 2,
      }),
    ).toBe(7);
    expect(telegramDiscoveryOperations).toEqual([
      "searchPublicChats",
      "channels.getChannelRecommendations",
    ]);
  });

  it("validates rich monitoring post metadata", () => {
    expect(
      telegramMonitoringResponseSchema.parse({
        ok: true,
        requestCount: 2,
        range: {
          startDate: "2026-10-01T00:00:00+00:00",
          endDate: "2026-10-01T23:59:59+00:00",
          timeZone: "Europe/Belgrade",
        },
        channels: [
          {
            channel: channel.channel,
            scannedCount: 1,
            returnedCount: 1,
            filteredCount: 0,
            filterBreakdown: {},
            truncated: false,
            nextBeforeMessageId: null,
            posts: [
              {
                id: "77",
                text: "#meetup https://example.com",
                date: "2026-10-01T10:00:00+00:00",
                editDate: null,
                url: "https://t.me/belgradesquash/77",
                authorSignature: null,
                senderId: "123",
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
                replyCount: 3,
                reactionCount: 4,
                reactions: [{ reaction: "👍", count: 4, chosen: false }],
                media: { type: "webpage", url: "https://example.com" },
                entities: [
                  {
                    type: "Hashtag",
                    text: "#meetup",
                    offset: 0,
                    length: 7,
                  },
                ],
                hashtags: ["meetup"],
                mentions: [],
                links: ["https://example.com"],
                buttons: [],
                forward: null,
                restrictionReasons: [],
                signals: {
                  hasText: true,
                  hasMedia: true,
                  hasExternalLink: true,
                  hasTelegramLink: false,
                  hasPrice: false,
                  hasPromoLanguage: false,
                  hasAdDisclosure: false,
                },
              },
            ],
          },
        ],
        warnings: [],
        billing: {
          perResultUsd: 0,
          paidStarsAllowed: false,
          note: "getHistory",
        },
      }).channels[0].posts[0].hashtags,
    ).toEqual(["meetup"]);
  });

  it("normalizes public channels as communities", () => {
    const store = new Store(":memory:");
    try {
      const original = store.source("source-telegram");
      const source = store.saveSource(
        {
          providerId: original.providerId,
          name: original.name,
          enabled: original.enabled,
          language: "ru",
          audience: "local",
          categories: ["Спорт"],
        },
        original.id,
      );
      const ctx = {
        source,
        scope: store.scope("belgrade"),
        secrets: {},
      };
      const raw = telegramRawItem(channel);
      expect(telegram.normalize(raw, ctx)).toMatchObject({
        type: "Community",
        title: "Belgrade Squash",
        url: "https://t.me/belgradesquash",
        externalId: "channel:123",
        memberCount: 420,
        category: "Общение",
        languages: [],
        audience: "all",
      });
    } finally {
      store.close();
    }
  });

  it("keeps publication time as provenance and not as the event date", () => {
    const store = new Store(":memory:");
    try {
      const source = store.source("source-telegram");
      const ctx = {
        source,
        scope: store.scope("belgrade"),
        secrets: {},
      };
      const post: TelegramSearchResult = {
        ...channel,
        kind: "post",
        operations: ["channels.searchPosts"],
        post: {
          id: "77",
          text: "Squash meetup this Friday\nBeginners welcome",
          date: "2026-10-01T10:00:00+00:00",
          views: 100,
          forwards: 2,
          url: "https://t.me/belgradesquash/77",
        },
      };
      const raw = telegramRawItem(post);
      const entity = telegram.normalize(raw, ctx)!;
      expect(raw.publishedAt).toBe("2026-10-01T10:00:00+00:00");
      expect(entity).toMatchObject({
        type: "Event",
        startAt: "",
        externalId: "post:123:77",
      });
      expect(entity.tags).toContain("needs-event-review");
    } finally {
      store.close();
    }
  });
});

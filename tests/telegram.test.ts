import { describe, expect, it } from "vitest";
import { Store } from "../server/store";
import {
  estimatedTelegramRequests,
  normalizeTelegramQueries,
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
        operations: [
          "searchPublicChats",
          "channels.searchPosts",
          "channels.getChannelRecommendations",
        ],
        seedCount: 2,
      }),
    ).toBe(10);
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

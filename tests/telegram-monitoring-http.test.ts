import express from "express";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";
import { defaultTelegramMonitoringSettings } from "../shared/telegram-monitoring.js";
import {
  telegramEventSelectionSchema,
  type TelegramEvent,
} from "../shared/telegram-events.js";

it("round-trips monitoring settings over HTTP and preserves them after invalid input", async () => {
  const store = new Store(":memory:");
  let server: Server | undefined;
  try {
    store.ingest(store.source("source-manual"), [
      {
        entity: {
          type: "Community",
          title: "Test club",
          tags: ["telegram"],
          url: "https://t.me/testclub",
        },
        raw: { externalId: "testclub", url: "", rawText: "", payload: {} },
      },
    ]);
    const app = express();
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      listening.on("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local TCP address");
    app.use(createApi(store, address.port));
    const base = `http://127.0.0.1:${address.port}/api`;
    const initial = await (
      await fetch(`${base}/telegram-monitoring/settings`)
    ).json();
    expect(initial.settings).toEqual(defaultTelegramMonitoringSettings());
    expect(initial.channels[0]).toMatchObject({
      title: "Test club",
      username: "testclub",
    });
    const body = {
      ...initial.settings,
      excludedChannels: ["@TESTCLUB"],
      excludeKeywords: [" #ПрОдАм "],
    };
    const response = await fetch(`${base}/telegram-monitoring/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).settings).toMatchObject({
      excludedChannels: ["testclub"],
      excludeKeywords: ["#продам"],
    });
    const invalid = await fetch(`${base}/telegram-monitoring/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, unknown: true }),
    });
    expect(invalid.status).toBe(400);
    const saved = await (
      await fetch(`${base}/telegram-monitoring/settings`)
    ).json();
    expect(saved.settings.excludeKeywords).toEqual(["#продам"]);
    expect(saved.channels).toHaveLength(1); // Disabled channels remain manageable.
    const count = await (
      await fetch(`${base}/telegram-events/count?scopeId=belgrade`)
    ).json();
    expect(count).toEqual({ count: 0 }); // A Community is not an Event.
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    store.close();
  }
});

it("persists Telegram reactions through their own HTTP endpoint without changing the channel", async () => {
  const store = new Store(":memory:");
  let server: Server | undefined;
  try {
    store.ingest(store.source("source-manual"), [
      {
        entity: {
          type: "Community",
          title: "HTTP test channel",
          tags: ["telegram"],
          url: "https://t.me/testclub",
        },
        raw: { externalId: "testclub", url: "", rawText: "", payload: {} },
      },
    ]);
    const communityId = store.entities()[0].id;
    const event: TelegramEvent = {
      ...telegramEventSelectionSchema.parse({
        communityId,
        postId: "12",
        activityKey: "http",
        title: "HTTP test event",
        startAt: "2099-10-03",
        relevanceScore: 8,
        relevanceReason: "Test",
        validationNotes: "Test",
      }),
      id: "telegram-http",
      channelTitle: "HTTP test channel",
      channelUsername: "testclub",
      channelTags: ["telegram"],
      postTitle: "Test",
      fullText: "Test text",
      preview: "Test text",
      publishedAt: "2026-10-02T10:00:00Z",
      postUrl: "https://t.me/testclub/12",
      postHashtags: [],
      favorite: false,
      reaction: "",
      dislikeReason: "",
      createdAt: "initial",
      updatedAt: "initial",
    };
    store.db
      .prepare(
        `INSERT INTO telegram_events (id,communityId,channelUsername,postId,activityKey,country,city,startAt,endAt,data,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.id,
        communityId,
        "testclub",
        "12",
        "http",
        "RS",
        "Belgrade",
        event.startAt,
        "",
        JSON.stringify(event),
        "initial",
        "initial",
      );
    const app = express();
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      listening.on("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local TCP address");
    app.use(createApi(store, address.port));
    const base = `http://127.0.0.1:${address.port}/api/telegram-events`;
    const patch = (body: unknown) =>
      fetch(`${base}/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const initial = await (await fetch(`${base}/${event.id}`)).json();
    expect(initial).toMatchObject({ favorite: false, reaction: "" });
    const liked = await patch({ reaction: "like", favorite: true });
    expect(liked.status).toBe(200);
    expect(await liked.json()).toMatchObject({
      reaction: "like",
      favorite: true,
    });
    expect(await (await patch({ reaction: "dislike" })).json()).toMatchObject({
      reaction: "dislike",
      favorite: true,
    });
    expect(await (await fetch(`${base}/${event.id}`)).json()).toMatchObject({
      reaction: "dislike",
      favorite: true,
    });
    expect(
      await (await patch({ dislikeReason: "  Too loud  " })).json(),
    ).toMatchObject({
      dislikeReason: "Too loud",
      reaction: "dislike",
      favorite: true,
    });
    expect(await (await fetch(`${base}/${event.id}`)).json()).toMatchObject({
      dislikeReason: "Too loud",
    });
    expect((await patch({ dislikeReason: "x".repeat(2001) })).status).toBe(400);
    expect(
      (await patch({ reaction: "dislike", title: "Overwrite" })).status,
    ).toBe(400);
    expect((await patch({})).status).toBe(400);
    const view = await (await fetch(`${base}?scopeId=belgrade`)).json();
    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toMatchObject({
      title: event.title,
      reaction: "dislike",
      favorite: true,
    });
    expect(
      await (await fetch(`${base}/count?scopeId=belgrade`)).json(),
    ).toEqual({ count: 1 });
    expect(await (await fetch(`${base}/review-context`)).json()).toHaveProperty(
      "profileFingerprint",
    );
    expect(store.entitySummary(communityId)).toMatchObject({
      favorite: false,
      reaction: "",
    });
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    store.close();
  }
});

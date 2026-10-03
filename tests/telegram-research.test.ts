import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTelegramResearchTools } from "../scripts/telegram-research-tools";
import {
  channelSearchInputSchema,
  pinnedInputSchema,
  filterTelegramCandidates,
  getTelegramChannelInfo,
  getTelegramPinnedMessages,
  searchTelegramChannelMessages,
  topicsInputSchema,
  topicPostsInputSchema,
  linkedPostsInputSchema,
  commentsInputSchema,
  getTelegramGroupTopics,
  getTelegramTopicPosts,
  getTelegramLinkedChatPosts,
  getTelegramPostComments,
} from "../server/providers/telegram/research";
import * as telegramTool from "../server/providers/telegram/tool";
import * as telegramClient from "../server/providers/telegram/client";

describe("Telegram channel-scoped research", () => {
  it("passes stable linked exclusions and reply-context filters without changing stored preferences", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-linked-test-"));
    const path = join(directory, "fixture.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE entities(type TEXT,data TEXT,overrides TEXT)",
    );
    db.prepare("INSERT INTO entities VALUES (?,?,?)").run(
      "Community",
      JSON.stringify({
        externalId: "channel:2",
        knownIds: { telegram_username: "quizpleasebeg" },
      }),
      JSON.stringify({ url: "https://t.me/renamedchat" }),
    );
    db.close();
    const pathMock = vi
      .spyOn(telegramTool, "databasePath")
      .mockReturnValue(path);
    const secretsMock = vi
      .spyOn(telegramTool, "requiredSecrets")
      .mockReturnValue({ TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "fixture" });
    const workerMock = vi
      .spyOn(telegramClient, "runWorker")
      .mockResolvedValue({
        ok: true,
        mode: "linked_posts",
        query: null,
        requestCount: 1,
        channels: [],
        warnings: [],
        range: { startDate: null, endDate: null, timeZone: "Europe/Belgrade" },
        billing: { perResultUsd: 0, paidStarsAllowed: false, note: "offline" },
      });
    try {
      await getTelegramLinkedChatPosts({ channels: ["testchannel"] });
      expect(workerMock).toHaveBeenCalledWith(
        "research",
        expect.anything(),
        expect.objectContaining({
          excludedChannelIds: ["2"],
          excludedUsernames: expect.arrayContaining(["quizpleasebeg"]),
          excludeReplies: false,
          excludeAdDisclosures: true,
          excludeKeywords: expect.any(Array),
        }),
      );
      const checkDb = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          checkDb.prepare("SELECT count(*) AS n FROM settings").get()?.n,
        ).toBe(0);
      } finally {
        checkDb.close();
      }
    } finally {
      workerMock.mockRestore();
      secretsMock.mockRestore();
      pathMock.mockRestore();
      unlinkSync(path);
      rmdirSync(directory);
    }
  });
  it("skips saved exclusions before credentials/session/network for every research mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-research-test-"));
    const path = join(directory, "fixture.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE settings(key TEXT,value TEXT)");
    db.close();
    const pathMock = vi
      .spyOn(telegramTool, "databasePath")
      .mockReturnValue(path);
    const secretsMock = vi
      .spyOn(telegramTool, "requiredSecrets")
      .mockImplementation(() => {
        throw new Error("Must not read credentials for excluded channels");
      });
    try {
      const input = { channels: ["quizpleasebeg"] };
      for (const result of [
        await getTelegramChannelInfo(input),
        await getTelegramPinnedMessages(input),
        await searchTelegramChannelMessages({ ...input, query: "поход" }),
        await getTelegramGroupTopics(input),
        await getTelegramTopicPosts({ ...input, topicId: "42" }),
        await getTelegramLinkedChatPosts(input),
        await getTelegramPostComments({ ...input, postId: "25" }),
      ]) {
        expect(result.requestCount).toBe(0);
        expect(result.channels).toEqual([]);
        expect(result.warnings).toHaveLength(1);
      }
      expect(secretsMock).not.toHaveBeenCalled();
    } finally {
      pathMock.mockRestore();
      secretsMock.mockRestore();
      unlinkSync(path);
      rmdirSync(directory);
    }
  });
  it("validates topic cursors and one-source context requests with hard bounds", () => {
    expect(
      topicsInputSchema.parse({ channels: ["testchannel"] })
        .maxTopicsPerChannel,
    ).toBe(50);
    for (const input of [
      { maxTopicsPerChannel: 101 },
      { topicCursors: { testchannel: { offsetId: 1, offsetTopic: 2 } } },
      {
        topicCursors: {
          testchannel: {
            offsetDate: "2026-10-01T10:00:00Z",
            offsetId: -1,
            offsetTopic: 2,
          },
        },
      },
    ])
      expect(
        topicsInputSchema.safeParse({ channels: ["testchannel"], ...input })
          .success,
      ).toBe(false);
    for (const schema of [topicPostsInputSchema, commentsInputSchema]) {
      const id =
        schema === topicPostsInputSchema ? { topicId: "42" } : { postId: "25" };
      expect(
        schema.safeParse({ channels: ["testchannel"], ...id }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ channels: ["testchannel", "otherchannel"], ...id })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({
          channels: ["testchannel"],
          ...id,
          startDate: "2026-10-02",
          endDate: "2026-10-01",
        }).success,
      ).toBe(false);
    }
    expect(
      topicPostsInputSchema.safeParse({
        channels: ["testchannel"],
        topicId: "2147483648",
      }).success,
    ).toBe(false);
    expect(
      commentsInputSchema.safeParse({ channels: ["testchannel"], postId: "0" })
        .success,
    ).toBe(false);
    expect(
      linkedPostsInputSchema.safeParse({
        channels: ["testchannel"],
        maxMessagesPerChannel: 100,
        maxScannedPerChannel: 10,
      }).success,
    ).toBe(false);
  });
  it.skipIf(!existsSync(".venv-telegram/bin/python"))(
    "tests direct pin/scoped requests, pagination and errors offline",
    () => {
      expect(
        execFileSync(
          ".venv-telegram/bin/python",
          ["tests/telegram-research-worker.py"],
          { encoding: "utf8" },
        ),
      ).toContain("passed");
    },
  );
  it("rejects unbounded/global targets and dates for pins", () => {
    for (const channels of [
      [],
      ["https://t.me/channelname/123"],
      ["https://evil.test/channelname"],
      ["https://t.me/+invite"],
      Array(21).fill("channelname"),
    ]) {
      expect(
        channelSearchInputSchema.safeParse({ channels, query: "поход" })
          .success,
      ).toBe(false);
    }
    expect(
      channelSearchInputSchema.safeParse({
        channels: ["channelname"],
        query: " ",
      }).success,
    ).toBe(false);
    expect(
      channelSearchInputSchema.safeParse({
        channels: ["channelname"],
        query: "x",
        startDate: "2026-10-02",
        endDate: "2026-10-01",
      }).success,
    ).toBe(false);
    expect(
      pinnedInputSchema.safeParse({
        channels: ["channelname"],
        startDate: "2026-10-01",
      }).success,
    ).toBe(false);
    expect(
      pinnedInputSchema.parse({ channels: ["channelname"] }).delaySeconds,
    ).toBe(4);
  });
  it("deduplicates hidden/renamed/overridden communities by ID and username without writes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE entities(id TEXT,type TEXT,data TEXT,overrides TEXT); CREATE TABLE settings(key TEXT,value TEXT)",
      );
      db.prepare("INSERT INTO entities VALUES (?,?,?,?)").run(
        "stored",
        "Community",
        JSON.stringify({
          externalId: "channel:123",
          knownIds: { telegram_username: "oldname" },
          url: "https://t.me/oldname",
        }),
        JSON.stringify({ url: "https://t.me/renamed" }),
      );
      const result = filterTelegramCandidates(db, {
        candidates: [
          { id: "123", username: "newname" },
          { username: "@OLDNAME" },
          { username: "https://t.me/renamed" },
          { username: "quizpleasebeg" },
          { id: "999", username: "freshname" },
          { id: "999", username: "anothername" },
        ],
      });
      expect(result.candidates).toEqual([{ id: "999", username: "freshname" }]);
      expect(result.skipped.map((row) => row.reason)).toEqual([
        "alreadyStored",
        "alreadyStored",
        "alreadyStored",
        "excluded",
        "duplicateCandidate",
      ]);
      expect(result.requestCount).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM entities").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });
  it("exposes scoped search in both MCPs and research steps only in discovery", async () => {
    for (const discovery of [true, false]) {
      const server = new McpServer({ name: "test", version: "1" });
      registerTelegramResearchTools(server, discovery);
      const client = new Client({ name: "test", version: "1" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name);
        expect(names).toContain("telegram_search_channel_messages");
        expect(names.includes("telegram_channel_pinned_messages")).toBe(
          discovery,
        );
        expect(names.includes("telegram_channel_info")).toBe(discovery);
        expect(names.includes("telegram_discovery_recent_posts")).toBe(
          discovery,
        );
        expect(names.includes("telegram_discovery_filter_candidates")).toBe(
          discovery,
        );
        for (const name of [
          "telegram_group_topics",
          "telegram_topic_posts",
          "telegram_linked_chat_posts",
          "telegram_post_comments",
        ])
          expect(names.includes(name)).toBe(discovery);
        if (discovery) {
          const result = await client.callTool({
            name: "telegram_topic_posts",
            arguments: { channels: ["testchannel"], topicId: "0" },
          });
          expect(result.isError).toBe(true);
        }
        const result = await client.callTool({
          name: "telegram_search_channel_messages",
          arguments: { channels: [], query: "x" },
        });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
});

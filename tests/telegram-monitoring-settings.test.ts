import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store.js";
import {
  defaultTelegramMonitoringSettings,
  isTelegramCommunity,
  matchesTelegramScore,
  isTelegramScoreInput,
} from "../shared/telegram-monitoring.js";
import {
  readTelegramMonitoringSettings,
  saveTelegramMonitoringSettings,
} from "../server/telegram-monitoring-settings.js";
import {
  getTelegramMonitoringChannels,
  monitorTelegramChannelPosts,
} from "../server/providers/telegram/tool.js";
import { monitorTelegramChannels } from "../server/providers/telegram/client.js";

vi.mock("../server/providers/telegram/client.js", async (original) => ({
  ...(await original<
    typeof import("../server/providers/telegram/client.js")
  >()),
  monitorTelegramChannels: vi.fn(async () => ({
    ok: true,
    requestCount: 1,
    channels: [],
    warnings: [],
    range: { startDate: null, endDate: null, timeZone: "Europe/Belgrade" },
    billing: { perResultUsd: 0, paidStarsAllowed: false, note: "test" },
  })),
}));
vi.mock("../server/secrets.js", () => ({
  readSecrets: () => ({
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "test-only-hash-not-a-secret",
  }),
  safeError: (error: Error) => error.message,
}));

let store: Store;
let directory: string;
let blockedId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "activity-telegram-policy-"));
  const path = join(directory, "test.sqlite");
  vi.stubEnv("ACTIVITY_DB", path);
  store = new Store(path);
  store.ingest(
    store.source("source-manual"),
    ["serbia_padel", "testclub"].map((username) => ({
      entity: {
        type: "Community" as const,
        title: username,
        url: `https://t.me/${username}`,
        tags: ["telegram"],
      },
      raw: { externalId: username, url: "", rawText: "", payload: {} },
    })),
  );
  blockedId = store
    .entities({ includeFiltered: true })
    .find((entity) => entity.title === "serbia_padel")!.id;
  vi.mocked(monitorTelegramChannels).mockClear();
});
afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("saved Telegram monitoring policy", () => {
  it("initializes the five exclusions and persists edited literal keyword rules", () => {
    expect(readTelegramMonitoringSettings(store.db).excludedChannels).toEqual(
      defaultTelegramMonitoringSettings().excludedChannels,
    );
    const input = {
      ...defaultTelegramMonitoringSettings(),
      excludedChannels: ["@TestClub", "https://t.me/testclub"],
      excludeKeywords: [" #SALE ", "#sale", ".*"],
    };
    saveTelegramMonitoringSettings(store.db, input);
    expect(readTelegramMonitoringSettings(store.db)).toMatchObject({
      excludedChannels: ["testclub"],
      excludeKeywords: ["#sale", ".*"],
    });
    expect(() =>
      saveTelegramMonitoringSettings(store.db, {
        ...input,
        excludeKeywords: [""],
      }),
    ).toThrow();
    expect(readTelegramMonitoringSettings(store.db).excludeKeywords).toEqual([
      "#sale",
      ".*",
    ]);
  });
  it.each([
    "@SERBIA_PADEL",
    "https://t.me/serbia_padel",
    "https://t.me/s/serbia_padel/12",
  ])("makes zero RPCs for explicit excluded %s", async (channel) => {
    const result = await monitorTelegramChannelPosts({ channels: [channel] });
    expect(result.requestCount).toBe(0);
    expect(result.channels).toEqual([]);
    expect(monitorTelegramChannels).not.toHaveBeenCalled();
  });
  it("makes zero RPCs for an excluded community ID", async () => {
    expect(
      (await monitorTelegramChannelPosts({ communityIds: [blockedId] }))
        .requestCount,
    ).toBe(0);
    expect(monitorTelegramChannels).not.toHaveBeenCalled();
  });
  it("omits disabled channels from default listing, but includes them in settings", () => {
    expect(
      getTelegramMonitoringChannels().map((channel) => channel.username),
    ).toEqual(["testclub"]);
    expect(
      getTelegramMonitoringChannels({ includeExcluded: true }),
    ).toHaveLength(2);
  });
  it("applies persisted keywords before the worker and does not allow per-call bypass", async () => {
    saveTelegramMonitoringSettings(store.db, {
      ...defaultTelegramMonitoringSettings(),
      excludeKeywords: ["#продам"],
    });
    await monitorTelegramChannelPosts({
      allStoredChannels: true,
      excludeKeywords: [],
      excludeReplies: false,
      excludeAdDisclosures: false,
    });
    expect(monitorTelegramChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: ["testclub"],
        excludeKeywords: ["#продам"],
        excludeReplies: true,
        excludeAdDisclosures: true,
      }),
    );
    await monitorTelegramChannelPosts({
      channels: ["@serbia_padel", "testclub"],
      excludeKeywords: ["rent"],
    });
    expect(monitorTelegramChannels).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channels: ["testclub"],
        excludeKeywords: ["#продам", "rent"],
      }),
    );
  });
  it("allows users to unblock channels and disable optional exclusions in settings", async () => {
    saveTelegramMonitoringSettings(store.db, {
      excludedChannels: [],
      excludeKeywords: [],
      excludeReplies: false,
      excludeAdDisclosures: false,
    });
    await monitorTelegramChannelPosts({ communityIds: [blockedId] });
    expect(monitorTelegramChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: ["serbia_padel"],
        excludeKeywords: [],
        excludeReplies: false,
        excludeAdDisclosures: false,
      }),
    );
  });
});
it("partitions Telegram channels/groups from other communities", () => {
  const base = {
    type: "Community" as const,
    tags: [],
    knownIds: {},
    url: "https://example.com",
  };
  expect(isTelegramCommunity(base)).toBe(false);
  expect(isTelegramCommunity({ ...base, tags: ["telegram", "group"] })).toBe(
    true,
  );
  expect(
    isTelegramCommunity({
      ...base,
      knownIds: { telegram_username: "testclub" },
    }),
  ).toBe(true);
  expect(isTelegramCommunity({ ...base, url: "https://t.me/testclub" })).toBe(
    true,
  );
  expect(
    isTelegramCommunity({
      ...base,
      type: "Event",
      url: "https://t.me/testclub/12",
    }),
  ).toBe(false);
});
it("uses one inclusive minimum AI-score, with clearing and zero removing the restriction", () => {
  expect(matchesTelegramScore(8, "8")).toBe(true);
  expect(matchesTelegramScore(9, "8")).toBe(true);
  expect(matchesTelegramScore(7, "8")).toBe(false);
  expect(matchesTelegramScore(10, "10")).toBe(true);
  expect(matchesTelegramScore(9, "10")).toBe(false);
  expect(matchesTelegramScore(0, "0")).toBe(true);
  expect(matchesTelegramScore(10, "")).toBe(true);
  expect(matchesTelegramScore(1, "")).toBe(true);
});
it("accepts only an empty field or integer AI-scores between zero and ten", () => {
  for (const value of ["", "0", "1", "9", "10"])
    expect(isTelegramScoreInput(value)).toBe(true);
  for (const value of ["11", "100", "-1", "8.5", "1e1", "abc", " "])
    expect(isTelegramScoreInput(value)).toBe(false);
});

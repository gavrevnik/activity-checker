import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Store } from "../server/store.js";
import {
  readTelegramMonitoringSettings,
  saveTelegramMonitoringSettings,
} from "../server/telegram-monitoring-settings.js";
it("removes only the two retired spam phrases, preserves exclusions/keywords and enforces the shared policy", () => {
  const store = new Store(":memory:");
  try {
    const old = {
      excludeKeywords: [
        "best-h@rdcore 18++ archive",
        "where you can earn more than $5,000 three times daily",
        "Keep custom phrase",
      ],
      excludedChannels: ["testchannel"],
      excludeReplies: false,
      excludeAdDisclosures: false,
      minTextLength: 70,
    };
    store.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .run("telegram-monitoring-settings", JSON.stringify(old));
    const sql = readFileSync(
      new URL("../migrations/033_unified_telegram_policy.sql", import.meta.url),
      "utf8",
    );
    store.transaction(() => store.db.exec(sql));
    expect(readTelegramMonitoringSettings(store.db)).toEqual({
      excludeKeywords: ["keep custom phrase"],
      excludedChannels: ["testchannel"],
      excludeReplies: true,
      excludeAdDisclosures: true,
      minTextLength: 70,
    });
    store.transaction(() => store.db.exec(sql));
    expect(readTelegramMonitoringSettings(store.db).minTextLength).toBe(70);
    for (const patch of [
      { minTextLength: 50 },
      { excludeReplies: false },
      { excludeAdDisclosures: false },
    ])
      expect(() =>
        saveTelegramMonitoringSettings(store.db, {
          ...readTelegramMonitoringSettings(store.db),
          ...patch,
        }),
      ).toThrow();
  } finally {
    store.close();
  }
});

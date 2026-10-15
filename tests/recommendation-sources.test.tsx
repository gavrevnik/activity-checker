import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { recommendationSearchSources } from "../server/recommendation-sources.js";
import { saveTelegramMonitoringSettings } from "../server/telegram-monitoring-settings.js";
import { defaultTelegramMonitoringSettings } from "../shared/telegram-monitoring.js";
import type { RecommendationItem } from "../shared/recommendations.js";
import { RecommendationSourcesList } from "../src/Recommendations.js";

let store: Store, root: string;
const channel = (id: string, username = id) => ({
  id,
  name: "Канал " + id,
  locator: "https://t.me/" + username,
  platform: "telegram",
  enabled: true,
  domains: ["activities"],
  roles: ["activity_monitoring"],
  metadata: { telegram_kind: "channel", username },
});
function catalog(shards: unknown[][]) {
  const paths = shards.map((rows, i) => {
    const path = "knowledge/indexes/sources-" + i + ".jsonl";
    writeFileSync(
      join(root, path),
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
    return path;
  });
  writeFileSync(
    join(root, "knowledge/indexes/manifest.json"),
    JSON.stringify({
      data_revision: "fixture-revision",
      datasets: { sources: { paths } },
    }),
  );
}
beforeEach(() => {
  store = new Store(":memory:");
  root = mkdtempSync(join(tmpdir(), "recommendation-sources-"));
  mkdirSync(join(root, "knowledge/indexes"), { recursive: true });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("reads every shard with the collection filter, deduplicates usernames and honors local exclusions without needing a Community", () => {
  catalog([
    [
      channel("a", "Alpha"),
      { ...channel("disabled"), enabled: false },
      { ...channel("group"), metadata: { telegram_kind: "group" } },
    ],
    [
      channel("b", "beta"),
      channel("alias", "alpha"),
      { ...channel("job"), domains: ["jobs"] },
      { ...channel("other"), roles: [] },
    ],
  ]);
  saveTelegramMonitoringSettings(store.db, {
    ...defaultTelegramMonitoringSettings(),
    excludedChannels: ["beta"],
  });
  const before = store.db.prepare("SELECT count(*) AS n FROM entities").get();
  const result = recommendationSearchSources(store, "belgrade", [], root);
  expect(result.warning).toBeNull();
  expect(result.knowledgeRevision).toBe("fixture-revision");
  expect(result.telegram.map((s) => [s.id, s.enabled])).toEqual([
    ["a", true],
    ["b", false],
  ]);
  expect(result.telegram[1].description).toContain("Исключён");
  expect(store.db.prepare("SELECT count(*) AS n FROM entities").get()).toEqual(
    before,
  );
});
it("refreshes Knowledge on each read and uses live provider metadata for aggregators and LLM Web", () => {
  catalog([[channel("a")]]);
  store.db
    .prepare("UPDATE sources SET enabled=1 WHERE id='source-afisha'")
    .run();
  const first = recommendationSearchSources(store, "belgrade", [], root);
  expect(first.other.find((s) => s.id === "source-afisha")?.method).toBe(
    "aggregator",
  );
  expect(first.other.find((s) => s.id === "source-meetup")).toMatchObject({
    method: "web",
    enabled: true,
    url: "https://www.meetup.com/",
  });
  expect(
    first.other.some((s) => /apify|google-places|foursquare/.test(s.id)),
  ).toBe(false);
  catalog([[channel("b")]]);
  store.db
    .prepare("UPDATE sources SET enabled=0 WHERE id='source-afisha'")
    .run();
  expect(
    recommendationSearchSources(store, "belgrade", [], root).other.some(
      (s) => s.id === "source-afisha",
    ),
  ).toBe(false);
  expect(
    recommendationSearchSources(store, "belgrade", [], root).telegram[0].id,
  ).toBe("b");
  expect(() =>
    recommendationSearchSources(store, "unknown", [], root),
  ).toThrow();
});
it("makes Knowledge failures visible and does not follow a manifest path outside its index directory", () => {
  const missing = recommendationSearchSources(store, "belgrade", [], root);
  expect(missing.warning).toBeTruthy();
  expect(missing.telegram).toEqual([]);
  expect(missing.other.length).toBeGreaterThan(0);
  writeFileSync(
    join(root, "outside.jsonl"),
    JSON.stringify(channel("outside")),
  );
  writeFileSync(
    join(root, "knowledge/indexes/manifest.json"),
    JSON.stringify({
      data_revision: "unsafe",
      datasets: { sources: { paths: ["outside.jsonl"] } },
    }),
  );
  expect(
    recommendationSearchSources(store, "belgrade", [], root).telegram,
  ).toEqual([]);
  catalog([[channel("a")]]);
  writeFileSync(
    join(root, "knowledge/indexes/sources-0.jsonl"),
    JSON.stringify(channel("a")) + "\ninvalid json",
  );
  const broken = recommendationSearchSources(store, "belgrade", [], root);
  expect(broken.warning).toBeTruthy();
  expect(broken.telegram).toEqual([]);
});
it("includes additional event websites once and excludes Telegram, existing domains, maps and forms", () => {
  catalog([[channel("a")]]);
  const item: RecommendationItem = {
    group: "social",
    title: "Встреча",
    description: "Разговоры",
    startAt: "2099-10-17",
    endAt: "",
    aiScore: 9,
    sourceName: "Организатор",
    sourceUrl: "https://organizer.example/event",
    eventUrl: "https://luma.com/fixture",
    tags: [],
  };
  const result = recommendationSearchSources(
    store,
    "belgrade",
    [
      item,
      item,
      {
        ...item,
        sourceUrl: "https://t.me/fixture/1",
        eventUrl: "https://forms.gle/fixture",
      },
      {
        ...item,
        sourceUrl: "https://www.meetup.com/fixture",
        eventUrl: "javascript:alert(1)",
      },
    ],
    root,
  );
  expect(result.additional.map((s) => new URL(s.url).hostname).sort()).toEqual([
    "luma.com",
    "organizer.example",
  ]);
  const html = renderToStaticMarkup(
    <RecommendationSourcesList sources={result} />,
  );
  expect(html).toContain("Источники поиска мероприятий");
  expect(html).toContain("Telegram-каналы · 1");
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain('href="https://t.me/a"');
  expect(html).toContain("Meetup");
  expect(html).toContain("Eventbrite");
  expect(html).toContain("luma.com");
});

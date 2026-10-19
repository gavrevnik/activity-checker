import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import {
  recommendationSearchSources,
  knowledgeVenueCities,
} from "../server/recommendation-sources.js";
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
function catalog(shards: unknown[][], members: string[] = []) {
  const paths = shards.map((rows, i) => {
    const path = "knowledge/indexes/sources-" + i + ".jsonl";
    writeFileSync(
      join(root, path),
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );
    return path;
  });
  writeFileSync(
    join(root, "knowledge/indexes/collections.json"),
    JSON.stringify([
      { id: "belgrade-live-venues", member_type: "source", members },
      { id: "belgrade-live-organizers", member_type: "source", members: [] },
    ]),
  );
  writeFileSync(
    join(root, "knowledge/indexes/manifest.json"),
    JSON.stringify({
      data_revision: "fixture-revision",
      datasets: {
        sources: { paths },
        collections: {
          paths: ["knowledge/indexes/collections.json"],
          format: "json",
        },
      },
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
it("includes explicitly readable public groups in their scope without enabling manual or legacy groups", () => {
  const group = (id: string, tool = "telegram_read_messages") => ({
    ...channel(id),
    metadata: {
      telegram_kind: "group",
      username: id,
      country: "MD",
      city: "Chisinau",
    },
    access: { method: "personal_radar_mcp", tool },
  });
  catalog([
    [
      group("voleinet"),
      { ...group("manual"), access: { method: "manual" } },
      group("legacy", "telegram_get_recent"),
      { ...group("disabled"), enabled: false },
      {
        ...group("othercity"),
        metadata: { ...group("x").metadata, city: "Balti" },
      },
      group("excluded"),
    ],
  ]);
  saveTelegramMonitoringSettings(store.db, {
    ...defaultTelegramMonitoringSettings(),
    excludedChannels: ["excluded"],
  });
  const rows = recommendationSearchSources(
    store,
    "chisinau",
    [],
    root,
  ).telegram;
  expect(rows.map((s) => [s.id, s.enabled])).toEqual([
    ["excluded", false],
    ["voleinet", true],
  ]);
  expect(
    recommendationSearchSources(store, "belgrade", [], root).telegram,
  ).toEqual([]);
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
  expect(html).toContain("Telegram-источники · 1");
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain('href="https://t.me/a"');
  expect(html).toContain("Meetup");
  expect(html).toContain("Eventbrite");
  expect(html).toContain("luma.com");
});

const venue = (id: string, url = "https://venue.example/" + id) => ({
  id,
  name: "Площадка " + id,
  aliases: ["Алиас " + id],
  locator: url,
  summary: "Международные концерты и стендап",
  platform: "web",
  enabled: true,
  domains: ["activities"],
  roles: ["venue_event_discovery"],
  access: { method: "web_search", search_domains: ["venue.example"] },
  metadata: {
    city: "Belgrade",
    country: "Serbia",
    source_kind: "venue",
    discovery_priority: "P1",
    event_types: ["live_music", "standup"],
    genres: ["rock"],
    page_type: "official_calendar",
    calendar_availability: "readable",
    checked_on: "2026-10-16",
    pages: [{ url, page_type: "official_calendar", availability: "readable" }],
  },
  record_path: "knowledge/indexes/records/source/" + id + ".json",
});
function details(rows: ReturnType<typeof venue>[]) {
  mkdirSync(join(root, "knowledge/indexes/records/source"), {
    recursive: true,
  });
  for (const row of rows)
    writeFileSync(join(root, row.record_path), JSON.stringify(row));
}
it("loads explicit collection members across shards with full records, scope/access filters and stable identity deduplication", () => {
  const rows = [
    venue("one"),
    venue("two"),
    venue("duplicate", "https://www.venue.example/one/"),
    { ...venue("disabled"), enabled: false },
    {
      ...venue("wrong-city"),
      metadata: { ...venue("x").metadata, city: "Novi Sad" },
    },
    {
      ...venue("wrong-country"),
      metadata: { ...venue("x").metadata, country: "Austria" },
    },
    { ...venue("wrong-role"), roles: ["reference"] },
    venue("outside-collection"),
  ];
  catalog(
    [[channel("a"), ...rows.slice(0, 2)], rows.slice(2)],
    rows.slice(0, -1).map((v) => v.id),
  );
  details(rows);
  const result = recommendationSearchSources(store, "belgrade", [], root);
  expect(result.venueWarning).toBeNull();
  expect(result.venues.map((v) => v.id)).toEqual(["one", "two"]);
  expect(result.venues[0].venue).toMatchObject({
    priority: "P1",
    aliases: ["Алиас one"],
    searchDomains: ["venue.example"],
  });
  expect(result.telegram.map((v) => v.id)).toEqual(["a"]);
  expect(recommendationSearchSources(store, "serbia", [], root).venues).toEqual(
    [],
  );
  const html = renderToStaticMarkup(
    <RecommendationSourcesList sources={result} />,
  );
  expect(html).toContain("Концертные площадки · 2");
  expect(html).toContain("P1 · Официальная афиша");
  expect(html).toContain("Концерты, Стендап");
  expect(html).not.toContain("live_music");
  expect(html).toContain('href="https://venue.example/one"');
});
it("distinguishes organizers, preserves same-domain venues and deduplicates local source URLs", () => {
  const one = venue("one", "https://www.meetup.com/"),
    two = venue("two", "https://www.meetup.com/another-venue");
  const organizer = {
    ...venue("organizer"),
    roles: ["organizer_event_discovery"],
    metadata: { ...venue("x").metadata, source_kind: "organizer" },
  };
  catalog([[one, two, organizer]], [one.id, two.id]);
  details([one, two]);
  writeFileSync(
    join(root, "knowledge/indexes/records/source/organizer.json"),
    JSON.stringify(organizer),
  );
  writeFileSync(
    join(root, "knowledge/indexes/collections.json"),
    JSON.stringify([
      {
        id: "belgrade-live-venues",
        member_type: "source",
        members: ["one", "two"],
      },
      {
        id: "belgrade-live-organizers",
        member_type: "source",
        members: ["organizer"],
      },
    ]),
  );
  const result = recommendationSearchSources(store, "belgrade", [], root);
  expect(result.venueWarning).toBeNull();
  expect(result.venues).toHaveLength(3);
  expect(result.venues.find((v) => v.id === "organizer")?.venue?.kind).toBe(
    "organizer",
  );
  expect(result.other.some((v) => v.id === "source-meetup")).toBe(false);
});
it("warns about missing collections/records and unsafe record symlinks without losing Telegram or aggregators", () => {
  const row = venue("one");
  catalog([[channel("a"), row]], [row.id]);
  let result = recommendationSearchSources(store, "belgrade", [], root);
  expect(result.venues).toEqual([]);
  expect(result.venueWarning).toBeTruthy();
  expect(result.telegram).toHaveLength(1);
  expect(result.other.length).toBeGreaterThan(0);
  expect(result.warning).toBeNull();
  details([row]);
  expect(
    recommendationSearchSources(store, "belgrade", [], root).venueWarning,
  ).toBeNull();
  rmSync(join(root, row.record_path));
  writeFileSync(join(root, "outside.json"), JSON.stringify(row));
  symlinkSync(join(root, "outside.json"), join(root, row.record_path));
  expect(
    recommendationSearchSources(store, "belgrade", [], root).venueWarning,
  ).toBeTruthy();
  rmSync(join(root, "knowledge/indexes/collections.json"));
  result = recommendationSearchSources(store, "belgrade", [], root);
  expect(result.venueWarning).toBeTruthy();
  expect(result.telegram).toHaveLength(1);
});

it("exposes the verified Russian Afisha venue URL as a concert search option and UI link", () => {
  const source = venue("hall");
  source.metadata.pages.push({
    url: "https://afisha.rs/ru/venues/test-hall/",
    page_type: "aggregator_listing",
    availability: "readable",
  });
  catalog([[source]], [source.id]);
  details([source]);
  const result = recommendationSearchSources(store, "belgrade", [], root);
  expect(result.venues[0].venue?.afishaVenueUrl).toBe(
    "https://afisha.rs/ru/venues/test-hall",
  );
  const html = renderToStaticMarkup(
    <RecommendationSourcesList sources={result} />,
  );
  expect(html).toContain('href="https://afisha.rs/ru/venues/test-hall"');
  expect(html).toContain("Afisha · события площадки");
});

it("keeps unverified Afisha venue links as Web targets without claiming parser readiness", () => {
  const source = venue("unverified");
  source.metadata.pages.push({
    url: "https://afisha.rs/ru/venues/not-read",
    page_type: "aggregator_listing",
    availability: "search_only",
  });
  catalog([[source]], [source.id]);
  details([source]);
  expect(
    recommendationSearchSources(store, "belgrade", [], root).venues[0].venue
      ?.afishaVenueUrl,
  ).toBeUndefined();
});

it("filters Telegram by country/city and never falls back to Serbia for Chisinau", () => {
  catalog([
    [
      channel("legacy"),
      {
        ...channel("belgrade"),
        metadata: { ...channel("b").metadata, country: "RS", city: "Belgrade" },
      },
      {
        ...channel("md"),
        metadata: { ...channel("m").metadata, country: "MD" },
      },
      {
        ...channel("chisinau"),
        metadata: {
          ...channel("c").metadata,
          country: "Moldova",
          city: "Chișinău",
        },
      },
      {
        ...channel("balti"),
        metadata: { ...channel("x").metadata, country: "MD", city: "Balti" },
      },
    ],
  ]);
  expect(
    recommendationSearchSources(store, "chisinau", [], root)
      .telegram.map((s) => s.id)
      .sort(),
  ).toEqual(["chisinau", "md"]);
  expect(
    recommendationSearchSources(store, "chisinau", [], root)
      .other.map((s) => s.id)
      .sort(),
  ).toEqual([
    "source-afisha-md",
    "source-afisha-mira",
    "source-allevents-chisinau",
    "source-fest-md",
    "source-frc-chisinau",
    "source-iticket-md",
    "source-moldova-travel",
    "source-sporter-md",
  ]);
  expect(
    recommendationSearchSources(store, "chisinau", [], root).venues,
  ).toEqual([]);
  expect(
    recommendationSearchSources(store, "belgrade", [], root)
      .telegram.map((s) => s.id)
      .sort(),
  ).toEqual(["belgrade", "legacy"]);
});

it("includes country-scoped web-first Knowledge sources without leaking into Serbia", () => {
  catalog([
    [
      {
        id: "md-web",
        name: "Sporter",
        locator: "https://sporter.md/ru/events/run",
        enabled: true,
        platform: "web",
        domains: ["activities"],
        roles: ["activity_monitoring"],
        metadata: { country: "MD" },
        access: { method: "web_search" },
        summary: "Проверять дату",
      },
    ],
  ]);
  expect(
    recommendationSearchSources(store, "chisinau", [], root).other,
  ).toContainEqual(expect.objectContaining({ id: "md-web", method: "web" }));
  expect(
    recommendationSearchSources(store, "belgrade", [], root).other.some(
      (s) => s.id === "md-web",
    ),
  ).toBe(false);
});

it("resolves venue geography from full records when compact shards omit source_kind", () => {
  const row = {
    id: "park",
    name: "Park",
    enabled: true,
    roles: ["venue_event_discovery"],
    metadata: { country: "MD", city: "Chisinau" },
    record_path: "knowledge/indexes/park.json",
  };
  catalog([[], [row]]);
  writeFileSync(
    join(root, row.record_path),
    JSON.stringify({
      ...row,
      aliases: ["Парк"],
      metadata: { ...row.metadata, source_kind: "venue" },
    }),
  );
  expect(knowledgeVenueCities("MD", root)).toEqual({
    Park: "Chisinau",
    Парк: "Chisinau",
  });
  expect(knowledgeVenueCities("RS", root)).toEqual({});
});

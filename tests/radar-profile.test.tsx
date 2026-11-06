import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import { profileSourceKey } from "../server/radar-profile.js";
import { disableSampleFilters } from "../shared/profile-filters.js";
import { Profile } from "../src/Profile.js";
import { defaultRecommendationPrompts } from "../shared/recommendations.js";

let store: Store, root: string;
const recordPath = (id: string) =>
  join(root, "knowledge/indexes/records/preference", id + ".json");
function records(criteria = "Synthetic shared activity criterion") {
  writeFileSync(
    recordPath("restaurant-preferences"),
    JSON.stringify({
      id: "restaurant-preferences",
      domain: "restaurants",
      statements: ["Synthetic restaurant criterion"],
    }),
  );
  writeFileSync(
    recordPath("cinema-preferences"),
    JSON.stringify({
      id: "cinema-preferences",
      domain: "cinema",
      statements: ["Synthetic film-club criterion"],
    }),
  );
  writeFileSync(
    recordPath("activity-monitoring-preferences"),
    JSON.stringify({
      id: "activity-monitoring-preferences",
      domain: "activities",
      summary: "Synthetic shared profile",
      statements: [criteria],
      metadata: {
        event_preferences: ["Synthetic event"],
        community_preferences: ["Synthetic community"],
        additional_preferences: "Synthetic existing language constraint",
        group_preferences: {
          ...defaultRecommendationPrompts,
          walks: "Synthetic trip cost constraint",
        },
      },
    }),
  );
  writeFileSync(
    recordPath("music-preferences"),
    JSON.stringify({
      id: "music-preferences",
      domain: "music",
      statements: ["Synthetic music preference"],
      metadata: { activity_artists: ["Synthetic artist"] },
    }),
  );
}
function input() {
  const { updatedAt: _, source: _source, ...value } = store.profile();
  return value;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "radar-profile-"));
  mkdirSync(join(root, "knowledge/indexes/records/preference"), {
    recursive: true,
  });
  records();
  store = new Store(":memory:");
  store.db
    .prepare("INSERT INTO settings(key,value) VALUES (?,?)")
    .run(profileSourceKey, JSON.stringify({ kind: "personal-radar", root }));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("reads canonical preferences, retains criteria and never modifies SQL on reads", () => {
  const before = store.db.prepare("SELECT total_changes() AS n").get()!.n;
  const profile = store.profile();
  expect(profile.summary).toBe("Synthetic shared profile");
  expect(profile.additionalPreferences).toContain(
    "Synthetic shared activity criterion",
  );
  expect(profile.additionalPreferences).toContain(
    "Synthetic existing language constraint",
  );
  expect(profile.additionalPreferences).toContain(
    "Synthetic film-club criterion",
  );
  expect(profile.musicPreferences).toEqual(["Synthetic music preference"]);
  expect(profile.additionalPreferences).toContain("Synthetic restaurant criterion");
  expect(profile.source?.preferenceIds).toContain("restaurant-preferences");
  expect(profile.artists).toEqual(["Synthetic artist"]);
  expect(profile.source?.readOnly).toBe(true);
  const revision = store.recommendationPreferences().revision;
  expect(store.recommendationPreferences().revision).toBe(revision);
  expect(store.db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
});

it("rejects a divergent local profile before any writes and keeps workflow settings editable", () => {
  const previous = store.db
    .prepare("SELECT data FROM user_profile WHERE id='main'")
    .get()!.data;
  const before = store.db.prepare("SELECT total_changes() AS n").get()!.n;
  expect(() =>
    store.saveProfile({ ...input(), summary: "Divergent local preference" }),
  ).toThrow(/Personal Radar/);
  expect(store.db.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
  const profile = store.saveProfile({
    ...input(),
    automaticFilters: disableSampleFilters(store.filterRules()),
    excludedTelegramChannels: [],
  });
  expect(profile.automaticFilters!.eventTitle.enabled).toBe(false);
  expect(profile.excludedTelegramChannels).toEqual([]);
  expect(
    store.db.prepare("SELECT data FROM user_profile WHERE id='main'").get()!
      .data,
  ).toBe(previous);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM catalog_outbox").get()!.n,
  ).toBe(0);
});

it("adds scoped concert criteria and invalidates recommendations when they change", () => {
  const previous = store.recommendationPreferences().revision;
  const path = recordPath("music-preferences");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.metadata.concert_preferences = ["Synthetic familiarity boost"];
  writeFileSync(path, JSON.stringify(record));
  expect(store.profile().musicPreferences).toEqual([
    "Synthetic music preference",
    "Только для концертов: Synthetic familiarity boost",
  ]);
  expect(store.recommendationPreferences().revision).not.toBe(previous);
});

it("Knowledge edits invalidate an in-flight publication and still permit local prompt edits", () => {
  const service = new Recommendations(store),
    view = service.view("belgrade", "week");
  records("Changed synthetic criterion");
  expect(store.profile().additionalPreferences).toContain(
    "Changed synthetic criterion",
  );
  expect(service.settings().revision).not.toBe(view.settings.revision);
  expect(() =>
    service.publish({
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "week",
      ...view.period,
      items: [],
      rejectedItems: [],
      settingsRevision: view.settings.revision,
      expectedSnapshotId: null,
      requestSummary: "Synthetic old selection",
    }),
  ).toThrow(/изменились/);
  const raw = store.storedRecommendationPreferences().revision;
  const result = service.saveSettings({
    expectedRevision: service.settings().revision,
    prompts: {
      ...service.settings().prompts,
      sport: "Changed synthetic search procedure",
    },
  });
  expect(result).toEqual(service.settings());
  expect(store.storedRecommendationPreferences().revision).toBe(raw + 1);
});

it("restaurant changes invalidate selection and missing criteria never fall back to local SQL", () => {
  const previous = store.recommendationPreferences().revision;
  const path = recordPath("restaurant-preferences");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.statements = ["Changed restaurant exclusion"];
  writeFileSync(path, JSON.stringify(record));
  expect(store.profile().additionalPreferences).toContain("Changed restaurant exclusion");
  expect(store.recommendationPreferences().revision).not.toBe(previous);
  rmSync(path);
  expect(() => store.profile()).toThrow(/restaurant-preferences/);
});

it("a missing, wrong-domain or symlinked index fails without using the obsolete SQL profile", () => {
  const path = recordPath("music-preferences"),
    body = readFileSync(path, "utf8");
  rmSync(path);
  expect(() => store.profile()).toThrow(/Personal Radar/);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(body), domain: "other" }));
  expect(() => store.profile()).toThrow(/Personal Radar/);
  rmSync(path);
  writeFileSync(join(root, "other.json"), body);
  symlinkSync(join(root, "other.json"), path);
  expect(() => store.profile()).toThrow(/Personal Radar/);
});

it("the profile panel marks canonical content read-only and keeps source exclusions editable", () => {
  const html = renderToStaticMarkup(
    <Profile profile={store.profile()} busy={false} onSave={async () => {}} />,
  );
  expect(html).toContain("Общий профиль Personal Radar");
  expect(html.match(/readOnly=""/gi)).toHaveLength(6);
  expect(html).toContain("Сохранить настройки отбора");
  expect(html).toContain("Не читать эти Telegram-каналы");
  const exclusions = html.match(/<textarea[^>]*>([^<]*)<\/textarea>/g)!.at(-1)!;
  expect(exclusions).not.toMatch(/readonly/i);
});

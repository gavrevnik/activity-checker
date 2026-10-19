import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import { defaultUserProfile } from "../server/profile.js";
import { defaultRecommendationPrompts } from "../shared/recommendations.js";
import {
  disableSampleFilters,
  profileFilterDescriptions,
} from "../shared/profile-filters.js";
import { readTelegramMonitoringSettings } from "../server/telegram-monitoring-settings.js";
import { prepareRecommendationTelegramSources } from "../server/recommendation-setup.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

it("saves another person's languages, prompts and disabled filters through one profile contract", () => {
  const profile = store.saveProfile({
    ...defaultUserProfile,
    summary: "Кишинёв. Говорю на молдавском/румынском и английском.",
    additionalPreferences:
      "Местная и румыноязычная программа подходит. Общего приоритета русского нет.",
    recommendationPrompts: {
      ...defaultRecommendationPrompts,
      concerts: "Концерты на румынском, английском и без языкового барьера.",
    },
    automaticFilters: disableSampleFilters(store.filterRules()),
    excludedTelegramChannels: [],
  });
  expect(profile.additionalPreferences).toContain("приоритета русского нет");
  expect(new Recommendations(store).settings().prompts).toEqual(
    profile.recommendationPrompts,
  );
  expect(store.filterRules().eventTitle.enabled).toBe(false);
  expect(profile.automaticFilters).toEqual(store.filterRules());
  expect(readTelegramMonitoringSettings(store.db).excludedChannels).toEqual([]);
  expect(profile.excludedTelegramChannels).toEqual([]);
  const descriptions = profileFilterDescriptions(profile.automaticFilters!);
  expect(descriptions.find((row) => row.code === "eventTitle")?.text).toContain(
    store.filterRules().eventTitle.keywords[0],
  );
});

it("keeps new preferences when a legacy client updates only the original profile fields", () => {
  store.saveProfile({
    ...defaultUserProfile,
    additionalPreferences: "Numai română și engleză.",
    excludedTelegramChannels: [],
  });
  const { additionalPreferences: _, ...legacy } = defaultUserProfile;
  const profile = store.saveProfile({
    ...legacy,
    summary: "Updated by legacy client",
  });
  expect(profile.additionalPreferences).toBe("Numai română și engleză.");
  expect(profile.excludedTelegramChannels).toEqual([]);
});

it("invalidates publication when additional profile preferences change during selection", () => {
  const service = new Recommendations(store),
    view = service.view("chisinau", "week");
  store.saveProfile({
    ...defaultUserProfile,
    additionalPreferences: "Fără prioritate pentru limba rusă.",
  });
  expect(() =>
    service.publish({
      id: randomUUID(),
      scopeId: "chisinau",
      kind: "week",
      ...view.period,
      items: [],
      rejectedItems: [],
      settingsRevision: view.settings.revision,
      expectedSnapshotId: null,
      requestSummary: "Old profile",
    }),
  ).toThrow(/изменились/);
});

it("prepares idempotent local Knowledge mappings on a completely empty database", () => {
  expect(
    store.entities().filter((row) => row.type === "Community"),
  ).toHaveLength(0);
  store.saveProfile({ ...defaultUserProfile, excludedTelegramChannels: [] });
  const first = prepareRecommendationTelegramSources(store, "chisinau");
  expect(first.channels.length).toBeGreaterThan(0);
  const id = first.channels[0].communityId;
  store.setState(id, { favorite: true });
  const second = prepareRecommendationTelegramSources(store, "chisinau");
  expect(second.created).toBe(0);
  expect(second.channels.map((row) => row.communityId).sort()).toEqual(
    first.channels.map((row) => row.communityId).sort(),
  );
  expect(store.entitySummary(id).favorite).toBe(true);
});

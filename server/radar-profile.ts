import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { userProfileSchema } from "../shared/model.js";
import {
  groupLabels,
  recommendationPromptsSchema,
} from "../shared/recommendations.js";
import { digest } from "./normalize.js";

export const profileSourceKey = "profile-preferences-source";
export const profileSourceSchema = z
  .object({
    kind: z.literal("personal-radar"),
    root: z.string().min(1),
  })
  .strict();

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const activityId = "activity-monitoring-preferences";
const musicId = "music-preferences";
const contentSchema = userProfileSchema.omit({
  automaticFilters: true,
  excludedTelegramChannels: true,
  recommendationPrompts: true,
});

/** Read only the existing builder's complete preference indexes. No YAML indexer or sync. */
export function readRadarProfile(input: unknown) {
  const source = profileSourceSchema.parse(input);
  const root = resolve(appRoot, source.root);
  const read = (id: string, domain: string) => {
    const path = resolve(
      root,
      "knowledge/indexes/records/preference",
      id + ".json",
    );
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
        throw Error("Not a supported record file");
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record.id !== id || record.domain !== domain)
        throw Error("Wrong preference identity");
      return { record, modified: stat.mtimeMs };
    } catch {
      throw Error(
        `Профиль Personal Radar недоступен: ${id}. Проверьте checkout и пересоберите индексы Knowledge.`,
      );
    }
  };
  const activity = read(activityId, "activities"),
    music = read(musicId, "music"),
    cinema = read("cinema-preferences", "cinema"),
    restaurants = read("restaurant-preferences", "restaurants");
  const metadata = activity.record.metadata;
  const criteria = z.array(z.string().min(1)).parse(activity.record.statements);
  const groups = recommendationPromptsSchema.parse(metadata?.group_preferences);
  const cinemaCriteria = z
    .array(z.string().min(1))
    .parse(cinema.record.statements);
  const restaurantCriteria = z.array(z.string().min(1)).parse(restaurants.record.statements);
  const core = contentSchema.parse({
    summary: activity.record.summary,
    eventPreferences: metadata?.event_preferences,
    communityPreferences: metadata?.community_preferences,
    musicPreferences: [
      ...z.array(z.string().min(1)).parse(music.record.statements),
      ...z.array(z.string().min(1)).parse(music.record.metadata?.concert_preferences ?? [])
        .map((criterion) => `Только для концертов: ${criterion}`),
    ],
    artists: music.record.metadata?.activity_artists,
    additionalPreferences: [
      z.string().parse(metadata?.additional_preferences),
      ...Object.entries(groups).map(
        ([group, value]) =>
          `${groupLabels[group as keyof typeof groupLabels]}: ${value}`,
      ),
      ...criteria,
      "Кинопрофиль для выбора программы киноклубов (явные предпочтения; социальные условия встречи применяются отдельно):\n" +
        cinemaCriteria.join("\n"),
      "Ресторанный профиль для выбора ресторанов, баров и гастрономических мест (явные предпочтения):\n" +
        restaurantCriteria.join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return {
    core,
    revision: digest(core),
    updatedAt: new Date(
      Math.max(activity.modified, music.modified, cinema.modified, restaurants.modified),
    ).toISOString(),
    source: {
      kind: "personal-radar" as const,
      readOnly: true as const,
      preferenceIds: [activityId, musicId, "cinema-preferences", "restaurant-preferences"],
    },
  };
}

export function profileContent(input: unknown) {
  return contentSchema.parse(input);
}

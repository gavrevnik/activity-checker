import { localDay } from "../shared/dates.js";
import {
  autoArchiveSettingsSchema,
  type AutoArchiveSettings,
} from "../shared/auto-archive.js";
import type { Store } from "./store.js";
import { AiDigests } from "./ai-digests.js";

const settingsKey = "auto-archive-past-events";
export function readAutoArchiveSettings(store: Store): AutoArchiveSettings {
  const row = store.db
    .prepare("SELECT value FROM settings WHERE key=?")
    .get(settingsKey) as { value: string } | undefined;
  return row
    ? autoArchiveSettingsSchema.parse(JSON.parse(row.value))
    : { enabled: true };
}
export function saveAutoArchiveSettings(store: Store, input: unknown) {
  const settings = autoArchiveSettingsSchema.parse(input);
  store.db
    .prepare(
      "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(settingsKey, JSON.stringify(settings));
  return settings;
}

// Only web startup and actual aggregator sync invoke this; opening a Store is not a trigger.
export function autoArchivePastEvents(
  store: Store,
  scopeId?: string,
  now = new Date(),
) {
  if (!readAutoArchiveSettings(store).enabled) return { archived: 0 };
  const scopes = scopeId ? [store.scope(scopeId)] : store.scopes();
  return store.transaction(() => ({
    archived: scopes.reduce(
      (total, scope) => {
        const today = localDay(now, scope.timezone);
        new AiDigests(store).archivePast(scope.id, today);
        return total + store.archivePastEvents(scope.id, today).archived;
      },
      0,
    ),
  }));
}

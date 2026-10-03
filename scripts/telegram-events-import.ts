import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { z } from "zod";
import { Store } from "../server/store.js";
import { TelegramEvents } from "../server/telegram-events.js";
import {
  telegramEventSelectionSchema,
  telegramChannelReviewSchema,
} from "../shared/telegram-events.js";
import { telegramMonitoringResponseSchema } from "../server/providers/telegram/client.js";

// Explicit, reviewed import only: monitoring itself remains read-only.
const [snapshotPath, reviewPath] = process.argv.slice(2);
if (!snapshotPath || !reviewPath)
  throw new Error(
    "Usage: telegram-events-import.ts monitoring-snapshot.json reviewed-draft.json",
  );
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const draft = z
  .object({
    expectedProfileFingerprint: z.string(),
    selections: z.array(
      telegramEventSelectionSchema
        .omit({ communityId: true })
        .extend({ username: z.string() }),
    ),
    channelReviews: z.array(
      telegramChannelReviewSchema
        .omit({ communityId: true })
        .extend({ username: z.string() }),
    ),
  })
  .strict()
  .parse(JSON.parse(readFileSync(reviewPath, "utf8")));
const batches = (snapshot.batches as unknown[]).map((batch) =>
  telegramMonitoringResponseSchema.parse(batch),
);
const monitoring = {
  ...batches[0],
  channels: batches.flatMap((batch) => batch.channels),
  requestCount: batches.reduce((count, batch) => count + batch.requestCount, 0),
  warnings: batches.flatMap((batch) => batch.warnings),
};
const byUsername = new Map(
  (snapshot.selected as Array<{ username: string; communityId: string }>).map(
    (item) => [item.username.toLowerCase(), item.communityId],
  ),
);
function selection<T extends { username: string }>(item: T) {
  const { username, ...value } = item;
  const communityId = byUsername.get(username.toLowerCase());
  if (!communityId) throw new Error(`Unknown selected channel @${username}`);
  return { ...value, communityId };
}
config({ path: ".env.local", quiet: true });
const store = new Store(
  process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite",
);
try {
  const before = store.db
    .prepare("SELECT count(*) AS n FROM entities WHERE type='Event'")
    .get()?.n;
  const result = new TelegramEvents(store).save({
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    expectedProfileFingerprint: draft.expectedProfileFingerprint,
    monitoring,
    selections: draft.selections.map(selection),
    channelReviews: draft.channelReviews.map(selection),
  });
  const after = store.db
    .prepare("SELECT count(*) AS n FROM entities WHERE type='Event'")
    .get()?.n;
  console.log(
    JSON.stringify({
      savedCount: result.savedCount,
      generalEventsBefore: before,
      generalEventsAfter: after,
      channels: result.review.channels.length,
    }),
  );
} finally {
  store.close();
}

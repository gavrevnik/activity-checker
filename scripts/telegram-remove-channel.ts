// Explicit local maintenance: never invoked automatically by monitoring or discovery.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../server/store.js";
import { telegramUsername } from "../shared/telegram-monitoring.js";

const [databasePath, requestedUsername] = process.argv.slice(2);
if (!databasePath || !requestedUsername)
  throw new Error(
    "Usage: telegram-remove-channel.ts database.sqlite @username",
  );
const store = new Store(resolve(databasePath));
try {
  const username = telegramUsername(requestedUsername);
  if (!/^[a-z0-9_]{5,}$/.test(username))
    throw new Error("Неверный публичный Telegram username.");
  const matches = store.db
    .prepare("SELECT * FROM entities WHERE type='Community'")
    .all()
    .filter((row) => {
      const data = {
        ...JSON.parse(String(row.data)),
        ...JSON.parse(String(row.overrides)),
      };
      return (
        telegramUsername(data.knownIds?.telegram_username || data.url || "") ===
        username
      );
    });
  if (matches.length !== 1)
    throw new Error(
      `Ожидался ровно один канал @${username}; найдено ${matches.length}.`,
    );
  const entity = matches[0];
  if (
    store.db
      .prepare("SELECT 1 FROM telegram_events WHERE communityId=?")
      .get(entity.id)
  )
    throw new Error(
      "У канала есть сохранённые tg события; их удаление требует отдельного решения.",
    );
  const backup = {
    entity,
    keys: store.db
      .prepare("SELECT * FROM entity_keys WHERE entityId=?")
      .all(entity.id),
    links: store.db
      .prepare("SELECT * FROM entity_source_links WHERE entityId=?")
      .all(entity.id),
    relations: store.db
      .prepare("SELECT * FROM entity_relations WHERE fromId=? OR toId=?")
      .all(entity.id, entity.id),
    duplicates: store.db
      .prepare("SELECT * FROM duplicate_pairs WHERE firstId=? OR secondId=?")
      .all(entity.id, entity.id),
    candidates: store.db
      .prepare("SELECT * FROM source_candidates WHERE entityId=?")
      .all(entity.id),
  };
  mkdirSync(".runtime", { recursive: true });
  const backupPath = resolve(
    ".runtime",
    `removed-channel-${username}-${Date.now()}.json`,
  );
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  store.transaction(() =>
    store.db
      .prepare("DELETE FROM entities WHERE id=? AND type='Community'")
      .run(entity.id),
  );
  console.log(
    JSON.stringify({
      removed: { id: entity.id, title: entity.title, username },
      backupPath,
      retained: "Historical raw source records and reviews",
    }),
  );
} finally {
  store.close();
}

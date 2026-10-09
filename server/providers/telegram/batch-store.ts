import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BatchRecord,
  BatchStore,
} from "@personal-radar/connectors/telegram";
const schema = () =>
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../migrations/030_telegram_connector_journal.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
/** Same application SQLite; no app initializer, seeds, new DB or user-data rewrites. */
export class SqliteTelegramBatchStore implements BatchStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(schema());
  }
  async get(id: string): Promise<BatchRecord | null> {
    const row = this.db
      .prepare(
        "SELECT payload FROM telegram_connector_requests WHERE requestId=?",
      )
      .get(id);
    return row ? JSON.parse(String(row.payload)) : null;
  }
  async compareAndSwap(id: string, revision: number | null, next: BatchRecord) {
    if (
      next.requestId !== id ||
      next.revision !== (revision === null ? 0 : revision + 1)
    )
      throw new Error("Invalid Telegram journal revision");
    const payload = JSON.stringify(next);
    const result =
      revision === null
        ? this.db
            .prepare(
              "INSERT INTO telegram_connector_requests(requestId,revision,payload,updatedAt) VALUES (?,?,?,?) ON CONFLICT(requestId) DO NOTHING",
            )
            .run(id, next.revision, payload, next.updatedAt)
        : this.db
            .prepare(
              "UPDATE telegram_connector_requests SET revision=?,payload=?,updatedAt=? WHERE requestId=? AND revision=?",
            )
            .run(next.revision, payload, next.updatedAt, id, revision);
    return Number(result.changes) === 1;
  }
  async getFloodWait(scope: string) {
    return Number(
      this.db
        .prepare(
          "SELECT blockedUntil FROM telegram_connector_gates WHERE scope=?",
        )
        .get(scope)?.blockedUntil ?? 0,
    );
  }
  async setFloodWait(scope: string, until: number) {
    this.db
      .prepare(
        "INSERT INTO telegram_connector_gates(scope,blockedUntil) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET blockedUntil=max(blockedUntil,excluded.blockedUntil)",
      )
      .run(scope, until);
  }
}
/** CLI/MCP adapters open only the existing database, and only when a journal is used. */
export class LazyTelegramBatchStore implements BatchStore {
  constructor(
    private readonly path: () => string = () =>
      process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite",
  ) {}
  private async use<T>(call: (store: SqliteTelegramBatchStore) => Promise<T>) {
    const path = resolve(this.path());
    if (!existsSync(path))
      throw new Error(
        "Activity database отсутствует; сначала запустите приложение",
      );
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000");
    try {
      return await call(new SqliteTelegramBatchStore(db));
    } finally {
      db.close();
    }
  }
  get(id: string) {
    return this.use((store) => store.get(id));
  }
  compareAndSwap(id: string, revision: number | null, next: BatchRecord) {
    return this.use((store) => store.compareAndSwap(id, revision, next));
  }
  getFloodWait(scope: string) {
    return this.use((store) => store.getFloodWait(scope));
  }
  setFloodWait(scope: string, until: number) {
    return this.use((store) => store.setFloodWait(scope, until));
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";

export const MCP_DAILY_LIMIT = 100;
export function quotaDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function quotaPath() {
  return (
    process.env.GOOGLE_PLACES_MCP_QUOTA_DB ||
    resolve(
      dirname(
        process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite",
      ),
      ".mcp-private/google-places.sqlite",
    )
  );
}
function safeParent(path: string) {
  const root = parse(path).root;
  let current = root;
  for (const part of dirname(path).slice(root.length).split("/")) {
    current = resolve(current, part);
    try {
      if (
        !lstatSync(current).isDirectory() ||
        lstatSync(current).isSymbolicLink()
      )
        throw new Error("Unsafe quota directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(current, { mode: 0o770 });
    }
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Unsafe quota file");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export class DailyLedger {
  db: DatabaseSync;
  constructor(path = quotaPath()) {
    if (path !== ":memory:") safeParent(resolve(path));
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS daily_usage(day TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 100));",
    );
  }
  status(date = new Date()) {
    const day = quotaDay(date);
    const row = this.db
      .prepare("SELECT used FROM daily_usage WHERE day=?")
      .get(day) as { used: number } | undefined;
    const used = row?.used || 0;
    return {
      day,
      timeZone: "Europe/Belgrade",
      limit: MCP_DAILY_LIMIT,
      used,
      remaining: MCP_DAILY_LIMIT - used,
    };
  }
  reserve(date = new Date()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = this.status(date);
      if (!status.remaining)
        throw new Error(
          "Дневная квота Google Places MCP исчерпана (100 запросов). ",
        );
      this.db
        .prepare(
          "INSERT INTO daily_usage(day,used) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<100",
        )
        .run(status.day);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
type Budget = {
  ledger: DailyLedger;
  maximum: number;
  used: number;
  deadline: number;
};
const context = new AsyncLocalStorage<Budget>();
export function mcpCanRequest() {
  const budget = context.getStore();
  return (
    !budget ||
    (Date.now() < budget.deadline &&
      budget.used < budget.maximum &&
      budget.ledger.status().remaining > 0)
  );
}
export function reserveMcpRequest(mode: string) {
  const budget = context.getStore();
  if (!budget) return;
  if (!["ids_only", "pro"].includes(mode))
    throw new Error("MCP разрешает только Basic/IDs-only и Pro.");
  if (Date.now() >= budget.deadline)
    throw new Error("Лимит времени этого запуска исчерпан.");
  if (budget.used >= budget.maximum)
    throw new Error("Лимит этого запуска Google Places MCP исчерпан.");
  budget.ledger.reserve();
  budget.used++;
}
export function mcpQuotaStatus() {
  const ledger = new DailyLedger();
  try {
    return ledger.status();
  } finally {
    ledger.close();
  }
}
export async function withMcpBudget<T>(
  execute: boolean,
  maximum: number | undefined,
  call: () => Promise<T>,
) {
  if (!execute)
    return {
      ...(await call()),
      dailyQuota: mcpQuotaStatus(),
      budget: {
        requested: maximum,
        allowed: 0,
        used: 0,
        stoppedAtLimit: false,
      },
    };
  if (!Number.isInteger(maximum) || maximum! < 1 || maximum! > 100)
    throw new Error(
      "Уточните у пользователя maxRequests для этого запуска (1–100).",
    );
  const ledger = new DailyLedger();
  try {
    const before = ledger.status();
    if (!before.remaining)
      throw new Error("Дневная квота Google Places MCP исчерпана.");
    const budget = {
      ledger,
      maximum: Math.min(maximum!, before.remaining),
      used: 0,
      deadline: Date.now() + 180000,
    };
    const result = await context.run(budget, call);
    return {
      ...result,
      budget: {
        requested: maximum,
        allowed: budget.maximum,
        used: budget.used,
        stoppedAtLimit: budget.used >= budget.maximum,
      },
      dailyQuota: ledger.status(),
    };
  } finally {
    ledger.close();
  }
}

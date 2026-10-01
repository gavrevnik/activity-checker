import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const foursquareMonthlyFreeRequests = 500;

const root = fileURLToPath(new URL("../../../", import.meta.url));

function quotaPath() {
  return (
    process.env.FOURSQUARE_QUOTA_FILE ||
    resolve(root, ".runtime/foursquare-quota.json")
  );
}

function month(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

type QuotaUsage = { month: string; used: number; updatedAt: string };

function readUsage(date = new Date()): QuotaUsage {
  const currentMonth = month(date);
  try {
    const parsed = JSON.parse(readFileSync(quotaPath(), "utf8")) as QuotaUsage;
    if (parsed.month !== currentMonth)
      return { month: currentMonth, used: 0, updatedAt: date.toISOString() };
    if (
      !Number.isInteger(parsed.used) ||
      parsed.used < 0 ||
      typeof parsed.updatedAt !== "string"
    )
      throw new Error("Файл локальной квоты Foursquare повреждён.");
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return { month: currentMonth, used: 0, updatedAt: date.toISOString() };
    if (
      error instanceof Error &&
      error.message === "Файл локальной квоты Foursquare повреждён."
    )
      throw error;
    throw new Error(
      "Не удалось прочитать локальный счётчик квоты Foursquare; запрос заблокирован.",
      { cause: error },
    );
  }
}

export function foursquareQuotaStatus(date = new Date()) {
  const usage = readUsage(date);
  return {
    ...usage,
    limit: foursquareMonthlyFreeRequests,
    remaining: Math.max(0, foursquareMonthlyFreeRequests - usage.used),
  };
}

export function reserveFoursquareRequest(date = new Date()) {
  const path = quotaPath();
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    const usage = readUsage(date);
    if (usage.used >= foursquareMonthlyFreeRequests)
      throw new Error(
        `Локальный лимит Foursquare исчерпан: ${foursquareMonthlyFreeRequests} запросов за ${usage.month}. Следующий запрос заблокирован, чтобы не перейти на платный тариф.`,
      );
    const next: QuotaUsage = {
      month: usage.month,
      used: usage.used + 1,
      updatedAt: date.toISOString(),
    };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
    return {
      ...next,
      limit: foursquareMonthlyFreeRequests,
      remaining: foursquareMonthlyFreeRequests - next.used,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    )
      throw new Error(
        "Другой Foursquare-запрос обновляет счётчик квоты. Повторите позже.",
      );
    throw error;
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}

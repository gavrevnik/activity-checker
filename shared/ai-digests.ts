import { z } from "zod";
import { inDateRange, localDay } from "./dates.js";

const httpUrl = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Нужна HTTP(S)-ссылка");
const eventDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const digestTagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u, "Тег без # и пробелов")
      .transform((tag) => tag.toLowerCase()),
  )
  .max(12)
  .transform((tags) => [...new Set(tags)]);
export const digestItemSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(5000),
    startAt: eventDate,
    endAt: z.union([eventDate, z.literal("")]).default(""),
    aiScore: z.number().min(0).max(10),
    sourceName: z.string().trim().min(1).max(300),
    sourceUrl: httpUrl,
    eventUrl: z.union([httpUrl, z.literal("")]).default(""),
    tags: digestTagsSchema.default([]),
  })
  .strict()
  .refine(
    (item) =>
      !item.endAt ||
      Date.parse(item.endAt) >= Date.parse(item.startAt) ||
      (item.endAt.length === 10 && item.endAt === localDay(item.startAt)),
    "Окончание события раньше начала",
  );
export const aiDigestInputSchema = z
  .object({
    id: z.uuid(),
    scopeId: z.string().min(1),
    title: z.string().trim().min(1).max(500),
    requestSummary: z.string().trim().min(1).max(3000),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    notes: z.string().trim().max(5000).default(""),
    items: z.array(digestItemSchema).max(100),
  })
  .strict()
  .refine((d) => d.endDate >= d.startDate, "Неверный период дайджеста");
export type AiDigestInput = z.output<typeof aiDigestInputSchema>;
export type AiDigest = AiDigestInput & {
  createdAt: string;
  archivedAt: string | null;
};
export type DigestItem = AiDigestInput["items"][number];

export function digestTitle(
  digest: Pick<AiDigestInput, "title" | "startDate" | "endDate">,
) {
  const date = (day: string, year = false) =>
    new Date(`${day}T12:00:00Z`)
      .toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        ...(year ? { year: "numeric" as const } : {}),
        timeZone: "UTC",
      })
      .replace(/\s*г\.$/, "");
  const { startDate: from, endDate: to } = digest;
  const period =
    from === to
      ? date(from)
      : from.slice(0, 7) === to.slice(0, 7)
        ? `${Number(from.slice(8))}–${date(to)}`
        : from.slice(0, 4) === to.slice(0, 4)
          ? `${date(from)} – ${date(to)}`
          : `${date(from, true)} – ${date(to, true)}`;
  // Remove only this digest's known period, including the old inline title form.
  const escaped = period
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s*–\s*/g, "\\s*[–-]\\s*");
  const title = digest.title
    .replace(new RegExp(`(^|[\\s·])${escaped}(?=$|[\\s:·])`, "gu"), "$1")
    .replace(/\s*·\s*$/, "")
    .replace(/\s+:/g, ":")
    .replace(/\s{2,}/g, " ")
    .trim();
  return `${title || "Дайджест"} · ${period}`;
}

export type DigestFilters = {
  from: string;
  to: string;
  minScore: number;
  tags: string[];
};

export function filterDigestItems(
  digest: AiDigest,
  filters: DigestFilters,
  timeZone: string,
) {
  const from = [digest.startDate, filters.from].sort().at(-1)!;
  const to = filters.to
    ? [digest.endDate, filters.to].sort()[0]
    : digest.endDate;
  if (from > to) return [];
  return digest.items.filter(
    (item) =>
      item.aiScore >= filters.minScore &&
      (!filters.tags.length ||
        filters.tags.some((tag) => item.tags.includes(tag))) &&
      inDateRange(item.startAt, item.endAt, from, to, timeZone),
  );
}

// Generate lazily so even unusually long stored ranges cannot freeze the UI.
export function* digestDays(
  digest: AiDigest,
  items: DigestItem[],
  filters: DigestFilters,
  timeZone: string,
) {
  const first = [digest.startDate, filters.from].sort().at(-1)!;
  const last = filters.to
    ? [digest.endDate, filters.to].sort()[0]
    : digest.endDate;
  const spans = items.map((item) => ({
    item,
    from:
      item.startAt.length === 10
        ? item.startAt
        : localDay(item.startAt, timeZone),
    to:
      (item.endAt || item.startAt).length === 10
        ? item.endAt || item.startAt
        : localDay(item.endAt || item.startAt, timeZone),
  }));
  const days = spans.map((span) => (span.from > first ? span.from : first));
  let day = days.sort()[0];
  while (day && day <= last) {
    const rows = spans
      .filter((span) => span.from <= day && span.to >= day)
      .map((span) => span.item)
      .sort(
        (a, b) => b.aiScore - a.aiScore || a.startAt.localeCompare(b.startAt),
      );
    if (rows.length) yield { day, items: rows };
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getUTCFullYear() > 9999) break;
    const nextDay = next.toISOString().slice(0, 10);
    // Jump over gaps instead of scanning days with no events.
    day = spans
      .filter((span) => span.to >= nextDay)
      .map((span) => (span.from > nextDay ? span.from : nextDay))
      .sort()[0];
  }
}

export function digestDayLabel(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  return `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(/\s*г\.$/, "")}, ${date.toLocaleDateString("ru-RU", { weekday: "long", timeZone: "UTC" })}`;
}

export function validateDigestPeriod(digest: AiDigestInput, timeZone: string) {
  if (
    digest.items.some(
      (item) =>
        !inDateRange(
          item.startAt,
          item.endAt,
          digest.startDate,
          digest.endDate,
          timeZone,
        ),
    )
  )
    throw new Error("Событие не пересекается с периодом дайджеста");
}

export function sortDigests(digests: AiDigest[], direction: "asc" | "desc") {
  return [...digests].sort((a, b) => {
    const dates =
      a.endDate.localeCompare(b.endDate) ||
      a.startDate.localeCompare(b.startDate);
    return (
      (direction === "asc" ? dates : -dates) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id)
    );
  });
}

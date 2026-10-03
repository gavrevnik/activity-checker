import { inDateRange, localDateTime, zone } from "./dates";
import type { TelegramEvent } from "./telegram-events";

export type TelegramEventSort = "date-asc" | "date-desc" | "score-desc";
type DatedEvent = Pick<TelegramEvent, "startAt" | "endAt">;
type SortableEvent = DatedEvent & Pick<TelegramEvent, "id" | "relevanceScore">;

function dateKey(value: string, timeZone: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return localDateTime(value, timeZone);
}

// Only reviewed occurrence dates belong here. publishedAt is never a fallback.
export function matchesTelegramEventDates(
  event: DatedEvent,
  from = "",
  to = "",
  timeZone = zone,
) {
  if (!from && !to) return true;
  if (!dateKey(event.startAt, timeZone)) return false;
  return inDateRange(event.startAt, event.endAt, from, to, timeZone);
}

export function sortTelegramEvents<T extends SortableEvent>(
  events: readonly T[],
  sort: TelegramEventSort,
  timeZone = zone,
): T[] {
  const keys = new Map(
    events.map((event) => [event.id, dateKey(event.startAt, timeZone)]),
  );
  return [...events].sort((a, b) => {
    if (sort === "score-desc" && a.relevanceScore !== b.relevanceScore)
      return b.relevanceScore - a.relevanceScore;
    const left = keys.get(a.id)!;
    const right = keys.get(b.id)!;
    // Undated legacy cards stay last in either direction; never use post dates.
    if (!left || !right)
      return Number(!left) - Number(!right) || a.id.localeCompare(b.id);
    const order = left.localeCompare(right);
    return (sort === "date-desc" ? -order : order) || a.id.localeCompare(b.id);
  });
}

import { CalendarDays } from "lucide-react";
import { eventDateRangeLabel } from "../shared/dates";

export function TelegramEventDateBadge({
  startAt,
  endAt,
  timeZone,
}: {
  startAt: string;
  endAt: string;
  timeZone: string;
}) {
  const label = eventDateRangeLabel(startAt, endAt, timeZone);
  if (!label) return null;
  return (
    <span
      className="badge event-date-badge telegram-event-date-badge"
      title="Дата мероприятия, не дата публикации"
      aria-label={`Дата мероприятия: ${label}`}
    >
      <CalendarDays size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

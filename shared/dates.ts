export const zone = "Europe/Belgrade";
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale, options]);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= 64) formatters.clear();
    formatters.set(key, formatter);
  }
  return formatter;
}
export function localDay(value: Date | string = new Date(), timeZone = zone) {
  const d = new Date(value);
  return dateFormatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
export function displayDate(
  value: string,
  options?: Intl.DateTimeFormatOptions,
) {
  if (!value) return "Дата уточняется";
  return dateFormatter("ru-RU", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    ...options,
  }).format(new Date(value.length === 10 ? value + "T12:00:00Z" : value));
}

export function eventDateLabel(value: string, timeZone = zone) {
  if (!value) return "";
  const dateOnly = value.length === 10;
  const date = new Date(dateOnly ? value + "T12:00:00Z" : value);
  if (Number.isNaN(date.valueOf())) return "";
  const day = dateOnly ? value : localDay(date, timeZone);
  const rawWeekday = dateFormatter("ru-RU", {
    timeZone: dateOnly ? "UTC" : timeZone,
    weekday: "short",
  })
    .format(date)
    .replace(/\.$/, "");
  const weekday =
    rawWeekday.charAt(0).toLocaleUpperCase("ru-RU") + rawWeekday.slice(1);
  const time = dateOnly
    ? ""
    : dateFormatter("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(date);
  return [day, weekday, time].filter(Boolean).join(" · ");
}

export function eventDateRangeLabel(
  startAt: string,
  endAt = "",
  timeZone = zone,
) {
  const start = eventDateLabel(startAt, timeZone);
  if (!start) return "";
  const end = eventDateLabel(endAt, timeZone);
  return end && end !== start ? `${start} - ${end}` : start;
}

export function inPeriod(
  start: string,
  period: string,
  from = "",
  to = "",
  today = localDay(),
) {
  if (!start) return false;
  const day = start.length === 10 ? start : localDay(start);
  if (period === "custom") return (!from || day >= from) && (!to || day <= to);
  const range = periodDateRange(period, today);
  return (!range.from || day >= range.from) && (!range.to || day <= range.to);
}

export function periodDateRange(period: string, today = localDay()) {
  const date = new Date(today + "T12:00:00Z");
  const weekday = (date.getUTCDay() + 6) % 7;
  const add = (n: number) => {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  if (period === "today") return { from: today, to: today };
  if (period === "week") return { from: today, to: add(6 - weekday) };
  if (period === "two-weeks") return { from: today, to: add(13 - weekday) };
  if (period === "weekend")
    return { from: add(5 - weekday), to: add(6 - weekday) };
  return { from: "", to: "" };
}

export function inDateRange(
  startAt: string,
  endAt = "",
  from = "",
  to = "",
  timeZone = zone,
) {
  if (!startAt) return false;
  const day = (value: string) =>
    value.length === 10 ? value : localDay(value, timeZone);
  const start = day(startAt);
  const end = endAt ? day(endAt) : start;
  return (!from || end >= from) && (!to || start <= to);
}

export function isPastEvent(
  startAt: string,
  endAt = "",
  today = localDay(),
  timeZone = zone,
) {
  const lastKnownDate = endAt || startAt;
  if (!lastKnownDate) return false;
  const day =
    lastKnownDate.length === 10
      ? lastKnownDate
      : localDay(lastKnownDate, timeZone);
  return day < today;
}

export function localDateTime(value: string, timeZone = zone): string {
  if (!value || value.length === 10) return value;
  const parts = Object.fromEntries(
    dateFormatter("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function startsAtOrAfterHour(
  startAt: string,
  hour = "",
  timeZone = zone,
) {
  if (!hour) return true;
  if (!startAt || startAt.length === 10) return false;
  const localHour = Number(localDateTime(startAt, timeZone).slice(11, 13));
  return localHour >= Number(hour);
}

export function fromLocalDateTime(
  day: string,
  time: string,
  timeZone = zone,
): string {
  if (!day) return "";
  if (!time) return day;
  const wanted = `${day}T${time}`;
  const wall = Date.parse(wanted + ":00Z");
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const represented = Date.parse(
      localDateTime(new Date(instant).toISOString(), timeZone) + ":00Z",
    );
    instant += wall - represented;
  }
  const result = new Date(instant).toISOString();
  if (localDateTime(result, timeZone) !== wanted)
    throw new Error(
      "Это местное время отсутствует из-за перевода часов. Выберите другое время.",
    );
  return result;
}

export function parseCalendarInput(
  day: string,
  time: string,
  timeZone = zone,
): string {
  let date = day.trim();
  const local = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  if (local) date = `${local[3]}-${local[2]}-${local[1]}`;
  if (!date) {
    if (time) throw new Error("Для времени укажите дату.");
    return "";
  }
  const parsed = new Date(date + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error("Укажите существующую дату в формате ДД.ММ.ГГГГ.");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error("Время укажите в формате ЧЧ:ММ, например 19:30.");
  return fromLocalDateTime(date, time, timeZone);
}

export const zone = "Europe/Belgrade";
export function localDay(value: Date | string = new Date(), timeZone = zone) {
  const d = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
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
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    ...options,
  }).format(new Date(value.length === 10 ? value + "T12:00:00Z" : value));
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
  const date = new Date(today + "T12:00:00Z");
  const weekday = (date.getUTCDay() + 6) % 7;
  const add = (n: number) => {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  if (period === "today") return day === today;
  if (period === "week") return day >= today && day <= add(6 - weekday);
  if (period === "weekend")
    return day >= add(5 - weekday) && day <= add(6 - weekday);
  if (period === "custom") return (!from || day >= from) && (!to || day <= to);
  return true;
}

export function localDateTime(value: string, timeZone = zone): string {
  if (!value || value.length === 10) return value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
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

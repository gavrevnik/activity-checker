const dateOf = (day: string) => new Date(`${day}T12:00:00Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

export const quickDatePeriods = [
  ["week", "Эта неделя"],
  ["two-weeks", "Эта и следующая неделя"],
  ["weekend", "Выходные"],
] as const;

export function isCalendarDaySelectable(day: string, today: string) {
  return day >= today;
}

export function shiftCalendarMonth(month: string, offset: number) {
  const date = dateOf(`${month.slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dayOf(date);
}

export function calendarDays(month: string) {
  const first = dateOf(`${month.slice(0, 7)}-01`);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return dayOf(date);
  });
}

export function orderedDateRange(first: string, second: string) {
  return first <= second
    ? { from: first, to: second }
    : { from: second, to: first };
}

export function dateRangeCaption(from: string, to: string) {
  const short = (day: string) => day.split("-").reverse().join(".");
  if (!from && !to) return "";
  if (from === to) return short(from);
  return `${short(from)} – ${short(to)}`;
}

import { it, expect } from "vitest";
import {
  eventDateLabel,
  eventDateRangeLabel,
  fromLocalDateTime,
  inDateRange,
  inPeriod,
  isPastEvent,
  localDateTime,
  parseCalendarInput,
  startsAtOrAfterHour,
} from "../shared/dates";

it("formats an event date with its local weekday and known time", () => {
  expect(eventDateLabel("2026-05-12T08:00:00Z", "Europe/Belgrade")).toBe(
    "2026-05-12 · Вт · 10:00",
  );
  expect(eventDateLabel("2026-05-10", "Europe/Belgrade")).toBe(
    "2026-05-10 · Вс",
  );
  expect(eventDateLabel("")).toBe("");
});

it("formats both ends of an event interval with full dates and local times", () => {
  expect(
    eventDateRangeLabel(
      "2026-05-01T08:00:00Z",
      "2026-05-10T18:00:00Z",
    ),
  ).toBe("2026-05-01 · Пт · 10:00 - 2026-05-10 · Вс · 20:00");
  expect(
    eventDateRangeLabel(
      "2026-10-02T17:00:00+02:00",
      "2026-10-02T19:00:00+02:00",
    ),
  ).toBe("2026-10-02 · Пт · 17:00 - 2026-10-02 · Пт · 19:00");
});

it("keeps each interval endpoint's precision and respects the selected timezone", () => {
  expect(
    eventDateRangeLabel("2026-10-02", "2026-10-04", "Pacific/Kiritimati"),
  ).toBe("2026-10-02 · Пт - 2026-10-04 · Вс");
  expect(
    eventDateRangeLabel("2026-10-02T17:00:00+02:00", "2026-10-04"),
  ).toBe("2026-10-02 · Пт · 17:00 - 2026-10-04 · Вс");
  expect(
    eventDateRangeLabel("2026-10-02", "2026-10-04T18:00:00Z"),
  ).toBe("2026-10-02 · Пт - 2026-10-04 · Вс · 20:00");
  expect(
    eventDateRangeLabel(
      "2026-09-30T23:30:00Z",
      "2026-10-02T22:00:00Z",
      "UTC",
    ),
  ).toBe("2026-09-30 · Ср · 23:30 - 2026-10-02 · Пт · 22:00");
  expect(
    eventDateRangeLabel(
      "2026-10-24T18:00:00Z",
      "2026-10-25T18:00:00Z",
    ),
  ).toBe("2026-10-24 · Сб · 20:00 - 2026-10-25 · Вс · 19:00");
});

it("keeps single dates and does not repeat identical or invalid endpoints", () => {
  expect(eventDateRangeLabel("2026-10-02")).toBe("2026-10-02 · Пт");
  expect(eventDateRangeLabel("2026-10-02", "2026-10-02")).toBe(
    "2026-10-02 · Пт",
  );
  expect(
    eventDateRangeLabel(
      "2026-10-02T17:00:00+02:00",
      "2026-10-02T15:00:00Z",
    ),
  ).toBe("2026-10-02 · Пт · 17:00");
  expect(eventDateRangeLabel("2026-10-02", "invalid")).toBe(
    "2026-10-02 · Пт",
  );
  expect(eventDateRangeLabel("", "2026-10-04")).toBe("");
  expect(eventDateRangeLabel("invalid", "2026-10-04")).toBe("");
});

it("includes the rest of this week and all of next week", () => {
  expect(inPeriod("2026-10-01", "two-weeks", "", "", "2026-10-01")).toBe(true);
  expect(inPeriod("2026-10-11", "two-weeks", "", "", "2026-10-01")).toBe(true);
  expect(inPeriod("2026-10-12", "two-weeks", "", "", "2026-10-01")).toBe(false);
});

it("converts summer and winter Belgrade wall times", () => {
  expect(fromLocalDateTime("2026-10-02", "20:00")).toBe(
    "2026-10-02T18:00:00.000Z",
  );
  expect(fromLocalDateTime("2026-12-02", "20:00")).toBe(
    "2026-12-02T19:00:00.000Z",
  );
  expect(localDateTime("2026-10-02T18:00:00Z")).toBe("2026-10-02T20:00");
});

it("treats an event as past only after its last known local date", () => {
  expect(isPastEvent("2026-09-30", "", "2026-10-01")).toBe(true);
  expect(isPastEvent("2026-09-30", "2026-10-02", "2026-10-01")).toBe(false);
  expect(
    isPastEvent("2026-09-30T23:30:00Z", "", "2026-10-01", "Europe/Belgrade"),
  ).toBe(false);
  expect(isPastEvent("", "", "2026-10-01")).toBe(false);
});

it("filters event intervals by an inclusive date range", () => {
  expect(inDateRange("2026-10-03", "", "2026-10-01", "2026-10-03")).toBe(true);
  expect(
    inDateRange("2026-09-29", "2026-10-02", "2026-10-01", "2026-10-05"),
  ).toBe(true);
  expect(inDateRange("2026-10-06", "", "2026-10-01", "2026-10-05")).toBe(false);
  expect(
    inDateRange(
      "2026-09-30T23:30:00Z",
      "",
      "2026-10-01",
      "2026-10-01",
      "Europe/Belgrade",
    ),
  ).toBe(true);
  expect(inDateRange("", "", "2026-10-01", "2026-10-05")).toBe(false);
});
it("filters events by their local start hour", () => {
  expect(
    startsAtOrAfterHour("2026-10-02T13:00:00Z", "15", "Europe/Belgrade"),
  ).toBe(true);
  expect(
    startsAtOrAfterHour("2026-10-02T12:59:00Z", "15", "Europe/Belgrade"),
  ).toBe(false);
  expect(startsAtOrAfterHour("2026-10-02", "15")).toBe(false);
  expect(startsAtOrAfterHour("2026-10-02", "")).toBe(true);
});
it("keeps unknown times empty and rejects DST gaps", () => {
  expect(fromLocalDateTime("2026-10-02", "")).toBe("2026-10-02");
  expect(() => fromLocalDateTime("2026-03-29", "02:30")).toThrow();
});

it("parses human dates and reports incomplete dates and times", () => {
  expect(parseCalendarInput("02.10.2026", "20:00")).toBe(
    "2026-10-02T18:00:00.000Z",
  );
  expect(() => parseCalendarInput("30.02.2026", "")).toThrow();
  expect(() => parseCalendarInput("02.10.2026", "25:00")).toThrow();
  expect(() => parseCalendarInput("", "20:00")).toThrow();
});

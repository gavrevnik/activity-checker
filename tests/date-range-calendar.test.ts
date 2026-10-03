import { describe, expect, it } from "vitest";
import {
  calendarDays,
  dateRangeCaption,
  orderedDateRange,
  shiftCalendarMonth,
  isCalendarDaySelectable,
  quickDatePeriods,
} from "../src/date-range-calendar";
import { periodDateRange } from "../shared/dates";

describe("date range calendar", () => {
  it("shares the same week and weekend presets between calendar and external chips", () => {
    expect(quickDatePeriods).toEqual([
      ["week", "Эта неделя"],
      ["two-weeks", "Эта и следующая неделя"],
      ["weekend", "Выходные"],
    ]);
    expect(
      quickDatePeriods.map(([value]) => periodDateRange(value, "2026-10-02")),
    ).toEqual([
      { from: "2026-10-02", to: "2026-10-04" },
      { from: "2026-10-02", to: "2026-10-11" },
      { from: "2026-10-03", to: "2026-10-04" },
    ]);
  });
  it("keeps the existing Saturday–Sunday weekend range across weekdays and year boundaries", () => {
    for (const today of ["2026-10-02", "2026-10-03", "2026-10-04"])
      expect(periodDateRange("weekend", today)).toEqual({
        from: "2026-10-03",
        to: "2026-10-04",
      });
    expect(periodDateRange("weekend", "2026-10-05")).toEqual({
      from: "2026-10-10",
      to: "2026-10-11",
    });
    expect(periodDateRange("weekend", "2026-12-31")).toEqual({
      from: "2027-01-02",
      to: "2027-01-03",
    });
  });
  it("disables past days but allows today and future days across month/year boundaries", () => {
    expect(isCalendarDaySelectable("2026-10-01", "2026-10-02")).toBe(false);
    expect(isCalendarDaySelectable("2026-10-02", "2026-10-02")).toBe(true);
    expect(isCalendarDaySelectable("2026-11-01", "2026-10-02")).toBe(true);
    expect(isCalendarDaySelectable("2026-12-31", "2027-01-01")).toBe(false);
    expect(isCalendarDaySelectable("2027-01-01", "2026-12-31")).toBe(true);
  });
  it("builds a Monday-first 6-week grid including adjacent months", () => {
    const days = calendarDays("2026-10-02");
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-09-28");
    expect(days[41]).toBe("2026-11-08");
    expect(new Set(days).size).toBe(42);
  });
  it("handles month boundaries, leap years and year changes", () => {
    expect(shiftCalendarMonth("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftCalendarMonth("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftCalendarMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(calendarDays("2024-02-01")).toContain("2024-02-29");
  });
  it("accepts forward, reverse, cross-year and single-day selection", () => {
    expect(orderedDateRange("2026-10-02", "2026-10-09")).toEqual({
      from: "2026-10-02",
      to: "2026-10-09",
    });
    expect(orderedDateRange("2027-01-02", "2026-12-31")).toEqual({
      from: "2026-12-31",
      to: "2027-01-02",
    });
    expect(orderedDateRange("2026-10-02", "2026-10-02")).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
  });
  it("shows the selected range without truncating its years", () => {
    expect(dateRangeCaption("", "")).toBe("");
    expect(dateRangeCaption("2026-10-02", "2026-10-02")).toBe("02.10.2026");
    expect(dateRangeCaption("2026-10-02", "2027-01-03")).toBe(
      "02.10.2026 – 03.01.2027",
    );
  });
});

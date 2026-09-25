import { it, expect } from "vitest";
import {
  fromLocalDateTime,
  localDateTime,
  parseCalendarInput,
} from "../shared/dates";
it("converts summer and winter Belgrade wall times", () => {
  expect(fromLocalDateTime("2026-10-02", "20:00")).toBe(
    "2026-10-02T18:00:00.000Z",
  );
  expect(fromLocalDateTime("2026-12-02", "20:00")).toBe(
    "2026-12-02T19:00:00.000Z",
  );
  expect(localDateTime("2026-10-02T18:00:00Z")).toBe("2026-10-02T20:00");
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

import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TelegramEventDateBadge } from "../src/TelegramEventDateBadge";
import {
  matchesTelegramEventDates,
  sortTelegramEvents,
} from "../shared/telegram-event-dates";

const wine = {
  id: "wine-oct2",
  startAt: "2026-10-02T17:00:00+02:00",
  endAt: "2026-10-02T19:00:00+02:00",
  publishedAt: "2026-09-30T09:00:00Z",
  relevanceScore: 8,
};
const festival = {
  ...wine,
  id: "fire-fest",
  startAt: "2026-10-02",
  endAt: "2026-10-04",
};

it("filters by the occurrence date rather than the post publication date", () => {
  expect(matchesTelegramEventDates(wine, "2026-09-30", "2026-09-30")).toBe(
    false,
  );
  expect(matchesTelegramEventDates(wine, "2026-10-02", "2026-10-02")).toBe(
    true,
  );
});

it("filters separate occurrences from one multi-date announcement independently", () => {
  const secondTasting = {
    ...wine,
    id: "wine-oct3",
    startAt: "2026-10-03T17:00:00+02:00",
    endAt: "",
  };
  expect(
    [wine, secondTasting].filter((event) =>
      matchesTelegramEventDates(event, "2026-10-03", "2026-10-03"),
    ),
  ).toEqual([secondTasting]);
});

it("includes overlapping festival ranges, including their last day", () => {
  expect(matchesTelegramEventDates(festival, "2026-10-03", "2026-10-03")).toBe(
    true,
  );
  expect(matchesTelegramEventDates(festival, "2026-10-04", "2026-10-04")).toBe(
    true,
  );
  expect(matchesTelegramEventDates(festival, "2026-10-05", "2026-10-05")).toBe(
    false,
  );
  expect(matchesTelegramEventDates(festival, "", "2026-10-01")).toBe(false);
  expect(matchesTelegramEventDates(festival, "2026-10-04", "")).toBe(true);
});

it("includes overnight events on their local ending day", () => {
  const overnight = {
    startAt: "2026-10-02T19:00:00+02:00",
    endAt: "2026-10-03T01:00:00+02:00",
  };
  expect(matchesTelegramEventDates(overnight, "2026-10-03", "2026-10-03")).toBe(
    true,
  );
});

it("uses the selected timezone, without shifting date-only event dates", () => {
  const midnight = { startAt: "2026-10-01T23:30:00Z", endAt: "" };
  expect(
    matchesTelegramEventDates(
      midnight,
      "2026-10-02",
      "2026-10-02",
      "Europe/Belgrade",
    ),
  ).toBe(true);
  expect(
    matchesTelegramEventDates(midnight, "2026-10-02", "2026-10-02", "UTC"),
  ).toBe(false);
  expect(
    matchesTelegramEventDates(
      festival,
      "2026-10-02",
      "2026-10-02",
      "Pacific/Kiritimati",
    ),
  ).toBe(true);
});

it("retains undated cards with no date filter but never substitutes publishedAt", () => {
  const undated = { ...wine, startAt: "", endAt: "" };
  expect(matchesTelegramEventDates(undated)).toBe(true);
  expect(matchesTelegramEventDates(undated, "2026-09-30", "2026-09-30")).toBe(
    false,
  );
  expect(
    matchesTelegramEventDates({ ...undated, startAt: "invalid" }, "2026-10-02"),
  ).toBe(false);
});

it("sorts chronologically by event start, not publication date or raw UTC offset", () => {
  const early = {
    ...wine,
    id: "early",
    startAt: "2026-10-02T14:00:00Z",
    publishedAt: "2026-10-01T00:00:00Z",
  };
  const events = [wine, early, festival];
  expect(sortTelegramEvents(events, "date-asc").map((e) => e.id)).toEqual([
    festival.id,
    early.id,
    wine.id,
  ]);
  expect(sortTelegramEvents(events, "date-desc").map((e) => e.id)).toEqual([
    wine.id,
    early.id,
    festival.id,
  ]);
  expect(events).toEqual([wine, early, festival]);
});

it("keeps unknown dates last in either date direction", () => {
  const undated = { ...wine, id: "undated", startAt: "", endAt: "" };
  for (const sort of ["date-asc", "date-desc"] as const) {
    expect(sortTelegramEvents([undated, wine], sort)).toEqual([wine, undated]);
  }
});

it("can sort by AI score without modifying dates or human feedback", () => {
  const favorite = {
    ...wine,
    id: "favorite",
    relevanceScore: 9,
    favorite: true,
    reaction: "like",
  };
  const events = [wine, favorite];
  expect(sortTelegramEvents(events, "score-desc")).toEqual([favorite, wine]);
  expect(favorite.favorite).toBe(true);
  expect(favorite.reaction).toBe("like");
});

it("renders a labeled event-date badge with both interval endpoints", () => {
  const markup = renderToStaticMarkup(
    <TelegramEventDateBadge
      startAt={festival.startAt}
      endAt={festival.endAt}
      timeZone="Europe/Belgrade"
    />,
  );
  expect(markup).toContain("telegram-event-date-badge");
  expect(markup).toContain("Дата мероприятия, не дата публикации");
  expect(markup).toContain("2026-10-02 · Пт - 2026-10-04 · Вс");
});

it("does not invent a time for date-only events or a badge for undated events", () => {
  const markup = renderToStaticMarkup(
    <TelegramEventDateBadge
      startAt="2026-10-02"
      endAt=""
      timeZone="Europe/Belgrade"
    />,
  );
  expect(markup).toContain("2026-10-02 · Пт");
  expect(markup).not.toContain("00:00");
  expect(
    renderToStaticMarkup(
      <TelegramEventDateBadge startAt="" endAt="" timeZone="Europe/Belgrade" />,
    ),
  ).toBe("");
});

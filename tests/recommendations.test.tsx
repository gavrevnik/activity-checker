import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import {
  recommendationExpired,
  recommendationInputSchema,
  remainingWeek,
  recommendationTime,
  recommendationsOnDay,
} from "../shared/recommendations.js";
import {
  RecommendationWeek,
  RecommendationYear,
  RecommendationSlot,
  RecommendationSlotDetails,
} from "../src/Recommendations.js";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const now = new Date("2026-10-13T10:00:00Z");
const item = () => ({
  title: "Разговорный клуб",
  description: "Общение в небольшой группе. Регистрация по ссылке.",
  startAt: "2026-10-13T18:30:00+02:00",
  endAt: "",
  aiScore: 9,
  sourceName: "Канал встреч",
  sourceUrl: "https://t.me/example/1",
  eventUrl: "https://example.org/event",
  group: "social" as const,
  tags: [],
});
const input = () => ({
  id: randomUUID(),
  scopeId: "belgrade",
  kind: "week" as const,
  startDate: "2026-10-13",
  endDate: "2026-10-18",
  settingsRevision: 0,
  expectedSnapshotId: null,
  requestSummary: "Рекомендации до воскресенья",
  items: [item()],
  notes: "Все источники проверены",
});

it("uses the local date and remaining calendar week, including Sunday and New Year", () => {
  expect(remainingWeek("2026-10-13")).toEqual([
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
  ]);
  expect(remainingWeek("2026-10-18")).toEqual(["2026-10-18"]);
  expect(remainingWeek("2026-12-31")).toEqual([
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
  ]);
  expect(
    new Recommendations(store).view(
      "belgrade",
      "week",
      new Date("2026-10-12T22:30:00Z"),
    ).period.startDate,
  ).toBe("2026-10-13");
});
it("publishes independent snapshots and retries safely without overwriting a newer result", () => {
  const service = new Recommendations(store),
    first = input();
  const saved = service.publish(first, now);
  expect(service.view("belgrade", "week", now).snapshot).toEqual(saved);
  expect(service.publish(first, now)).toEqual(saved);
  expect(() =>
    service.publish({ ...first, requestSummary: "Changed" }, now),
  ).toThrow(/ID/);
  const next = { ...first, id: randomUUID(), expectedSnapshotId: saved.id };
  expect(service.publish(next, now).id).toBe(next.id);
  expect(service.publish(first, now)).toEqual(saved);
  expect(service.latest("belgrade", "week")?.id).toBe(next.id);
  expect(() => service.publish({ ...first, id: randomUUID() }, now)).toThrow(
    /изменились/,
  );
  expect(service.latest("serbia", "week")).toBeNull();
  expect(store.entities()).toHaveLength(0);
});
it("persists all four prompts and rejects stale settings and stale selection", () => {
  const service = new Recommendations(store),
    previous = service.settings();
  const updated = service.saveSettings({
    expectedRevision: 0,
    prompts: { ...previous.prompts, social: "Разговорные клубы и караоке" },
  });
  expect(new Recommendations(store).settings()).toEqual(updated);
  expect(updated.revision).toBe(1);
  expect(() =>
    service.saveSettings({ expectedRevision: 0, prompts: previous.prompts }),
  ).toThrow(/изменились/);
  expect(() => service.publish(input(), now)).toThrow(/Промпты/);
  expect(() =>
    service.saveSettings({
      expectedRevision: 1,
      prompts: { ...previous.prompts, walks: " " },
    }),
  ).toThrow();
});
it("rejects expired/out-of-range events, duplicates, unsafe links and wrong annual groups", () => {
  const service = new Recommendations(store),
    data = input();
  for (const startAt of [
    "2026-10-12",
    "2026-10-19",
    "2026-10-13T09:00:00+02:00",
  ]) {
    expect(() =>
      service.publish({ ...data, items: [{ ...item(), startAt }] }, now),
    ).toThrow(/периода/);
  }
  expect(() =>
    service.publish({ ...data, items: [item(), item()] }, now),
  ).toThrow(/повторные/);
  expect(() =>
    service.publish(
      {
        ...data,
        items: [{ ...item(), startAt: "2026-10-12", endAt: "2026-10-16" }],
      },
      now,
    ),
  ).toThrow(/периода/);
  expect(
    recommendationInputSchema.safeParse({
      ...data,
      items: [{ ...item(), eventUrl: "javascript:alert(1)" }],
    }).success,
  ).toBe(false);
  expect(() =>
    service.publish({ ...data, endDate: "2026-10-19" }, now),
  ).toThrow(/Период/);
  const year = {
    ...data,
    kind: "concerts-2026",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  };
  expect(() => service.publish(year, now)).toThrow(/группы/);
  expect(
    service.publish({ ...year, items: [{ ...item(), group: "concerts" }] }, now)
      .kind,
  ).toBe("concerts-2026");
  expect(service.latest("belgrade", "week")).toBeNull();
});
it("places events only on their start date and keeps unknown times and DST local times", () => {
  const unknown = { ...item(), startAt: "2026-10-13" },
    ongoing = { ...item(), startAt: "2026-10-12", endAt: "2026-10-15" };
  expect(recommendationTime(unknown, "2026-10-13", "Europe/Belgrade")).toBe(
    "Время уточняется",
  );
  expect(recommendationTime(ongoing, "2026-10-13", "Europe/Belgrade")).toBe(
    "Время уточняется",
  );
  expect(
    recommendationsOnDay([ongoing], "2026-10-14", "Europe/Belgrade"),
  ).toHaveLength(0);
  expect(
    recommendationsOnDay([ongoing], "2026-10-12", "Europe/Belgrade"),
  ).toHaveLength(1);
  expect(recommendationExpired(ongoing, now, "Europe/Belgrade")).toBe(false);
  expect(recommendationExpired(unknown, now, "Europe/Belgrade")).toBe(false);
  expect(
    recommendationTime(
      { ...item(), startAt: "2026-10-25T18:00:00Z" },
      "2026-10-25",
      "Europe/Belgrade",
    ),
  ).toBe("19:00");
  const html = renderToStaticMarkup(
    <RecommendationWeek
      today="2026-10-13"
      timeZone="Europe/Belgrade"
      items={[item(), unknown]}
    />,
  );
  expect(html).toContain("18:30");
  expect(html).toContain("Без времени");
  expect(html.indexOf('class="rec-hour">Без времени')).toBeGreaterThan(
    html.indexOf('class="rec-hour">18:00'),
  );
  expect(html).toContain("вторник (2)");
  expect(html).toContain("воскресенье (0)");
  expect(html).not.toContain("rec-week-strip");
  expect(html).not.toContain("понедельник");
  expect(html).toContain('href="https://t.me/example/1"');
  expect(html).not.toContain('href="https://example.org/event"');
  expect(html).not.toContain("9/10");
  expect(html).toContain("lucide-users");
  expect(html).toContain("Канал встреч");
  expect(html.match(/class="rec-hour">([^<]+)/)?.[1]).toBe("18:00");
  expect(html).not.toContain('class="rec-hour">17:00');
  expect(html).not.toContain('class="rec-hour">19:00');
  const earlier = renderToStaticMarkup(
    <RecommendationWeek
      today="2026-10-13"
      timeZone="Europe/Belgrade"
      items={[
        item(),
        {
          ...item(),
          title: "Дневная встреча",
          startAt: "2026-10-14T12:30:00Z",
        },
      ]}
    />,
  );
  expect(earlier.match(/class="rec-hour">([^<]+)/)?.[1]).toBe("14:00");
  expect(earlier).toContain("Дневная встреча");
  expect(earlier).toContain('class="rec-hour">18:00');
  expect(earlier).not.toContain('class="rec-hour">19:00');
  const dateOnly = renderToStaticMarkup(
    <RecommendationWeek
      today="2026-10-13"
      timeZone="Europe/Belgrade"
      items={[unknown]}
    />,
  );
  expect(dateOnly.match(/class="rec-hour">([^<]+)/)?.[1]).toBe("Без времени");
});
it("renders annual month buckets chronologically with weekday and source links", () => {
  const html = renderToStaticMarkup(
    <RecommendationYear
      timeZone="Europe/Belgrade"
      onHide={() => {}}
      onFavorite={() => {}}
      isFavorite={(event) => event.title === "Фестиваль еды"}
      items={[
        {
          ...item(),
          title: "Фестиваль еды",
          startAt: "2026-12-01",
          endAt: "2026-12-03",
          group: "concerts",
        },
        { ...item(), startAt: "2026-11-01T17:00:00Z", group: "concerts" },
      ]}
    />,
  );
  expect(html.indexOf("ноябрь")).toBeLessThan(html.indexOf("декабрь"));
  expect(html).toContain(">вс<");
  expect(html).toContain("18:00");
  expect(html).toContain('href="https://t.me/example/1"');
  expect(html).toContain("Фестиваль еды");
  expect(html).toContain('aria-label="Скрыть: Фестиваль еды"');
  expect(html).toContain('aria-label="Убрать из избранного: Фестиваль еды"');
  expect(html).toContain('aria-label="В избранное: Разговорный клуб"');
});

it("displays exact start times without a symbolic end time and groups colliding titles", () => {
  const long = { ...item(), endAt: "2026-10-16T21:00:00+02:00" };
  expect(recommendationTime(long, "2026-10-13", "Europe/Belgrade")).toBe(
    "18:30",
  );
  expect(
    recommendationTime(
      { ...item(), startAt: "2026-10-13T23:30:00+02:00" },
      "2026-10-13",
      "Europe/Belgrade",
    ),
  ).toBe("23:30");
  const rows = [
    long,
    {
      ...item(),
      title: "Караоке",
      startAt: "2026-10-13T18:50:00+02:00",
      eventUrl: "https://example.org/karaoke",
    },
  ];
  const grouped = renderToStaticMarkup(
    <RecommendationSlot
      items={rows}
      day="2026-10-13"
      hour={18}
      timeZone="Europe/Belgrade"
      onOpen={() => {}}
    />,
  );
  expect(grouped).toContain("Разговорный клуб");
  expect(grouped).toContain("Караоке");
  expect(grouped).toContain("<button");
  expect(grouped).not.toContain(item().description);
  expect(grouped).not.toContain(item().sourceName);
  const details = renderToStaticMarkup(
    <RecommendationSlotDetails
      items={rows}
      day="2026-10-13"
      hour={18}
      timeZone="Europe/Belgrade"
      onClose={() => {}}
    />,
  );
  expect(details).toContain(item().description);
  expect(details).toContain(item().sourceName);
  expect(details).toContain("18:50");
  expect(details).not.toContain("18:50–19:50");
  expect(details).not.toContain("18:00–19:00");
  expect(details).toContain('href="https://t.me/example/1"');
  expect(details).not.toContain('href="https://example.org/karaoke"');
  expect(details).not.toContain("9/10");
  const week = renderToStaticMarkup(
    <RecommendationWeek
      items={rows}
      today="2026-10-13"
      timeZone="Europe/Belgrade"
    />,
  );
  expect(week.match(/Разговорный клуб/g)).toHaveLength(1);
  expect(week).not.toContain("16:00–21:00");
});

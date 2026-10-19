import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { Recommendations } from "../server/recommendations.js";
import { nextWeek, recommendationPeriod } from "../shared/recommendations.js";
import { RecommendationWeek } from "../src/Recommendations.js";

it("uses the next full Monday–Sunday across Sundays, New Year and DST", () => {
  expect(nextWeek("2026-10-18")).toEqual(nextWeek("2026-10-12"));
  expect(recommendationPeriod("next-week", "2026-12-31")).toEqual({
    startDate: "2027-01-04",
    endDate: "2027-01-10",
  });
  const store = new Store(":memory:");
  try {
    const service = new Recommendations(store);
    // Sunday in Serbia, already Monday in Moldova.
    const now = new Date("2026-10-18T21:30:00Z");
    expect(service.view("belgrade", "next-week", now).period.startDate).toBe(
      "2026-10-19",
    );
    expect(service.view("chisinau", "next-week", now).period.startDate).toBe(
      "2026-10-26",
    );
    expect(
      service.view("chisinau", "next-week", new Date("2026-10-24T23:30:00Z"))
        .period,
    ).toEqual({ startDate: "2026-10-26", endDate: "2026-11-01" });
  } finally {
    store.close();
  }
});

it("keeps next week, current week and cities independent, including favorites and restored events", () => {
  const store = new Store(":memory:");
  try {
    const service = new Recommendations(store);
    const now = new Date("2026-10-16T10:00:00Z");
    const item = {
      title: "Разговорный клуб",
      description: "Русскоязычная встреча",
      startAt: "2026-10-20",
      endAt: "",
      aiScore: 8,
      sourceName: "Клуб",
      sourceUrl: "https://example.org/club",
      eventUrl: "https://example.org/event",
      group: "social" as const,
      tags: [],
    };
    const payload = {
      id: randomUUID(),
      scopeId: "chisinau",
      kind: "next-week" as const,
      ...recommendationPeriod("next-week", "2026-10-16"),
      settingsRevision: 0,
      expectedSnapshotId: null,
      requestSummary: "Следующая неделя",
      items: [item],
      notes: "",
    };
    const saved = service.publish(payload, now);
    expect(service.publish(payload, now)).toEqual(saved);
    expect(service.latest("belgrade", "next-week")).toBeNull();
    expect(service.latest("chisinau", "week")).toBeNull();
    service.saveFavorite(
      {
        scopeId: "chisinau",
        item: { ...item, startAt: "2026-10-17" },
        favorite: true,
      },
      now,
    );
    expect(service.view("chisinau", "next-week", now).snapshot?.items).toEqual([
      item,
    ]);
    service.hide({ scopeId: "chisinau", item }, now);
    expect(service.view("chisinau", "next-week", now).snapshot?.items).toEqual(
      [],
    );
    expect(service.hidden("belgrade", now)).toEqual([]);
    service.restore(
      { scopeId: "chisinau", id: service.hidden("chisinau", now)[0].id },
      now,
    );
    expect(service.view("chisinau", "next-week", now).snapshot?.items).toEqual([
      item,
    ]);
    expect(() =>
      service.publish(
        {
          ...payload,
          id: randomUUID(),
          expectedSnapshotId: saved.id,
          items: [{ ...item, startAt: "2026-10-18" }],
        },
        now,
      ),
    ).toThrow(/периода/);
    expect(() =>
      service.publish(
        {
          ...payload,
          id: randomUUID(),
          expectedSnapshotId: saved.id,
          items: [{ ...item, startAt: "2026-10-26" }],
        },
        now,
      ),
    ).toThrow(/периода/);
    // On the next Monday this snapshot must not leak its old dates into the new next week.
    expect(
      service.view("chisinau", "next-week", new Date("2026-10-19T10:00:00Z"))
        .snapshot?.items,
    ).toEqual([]);
  } finally {
    store.close();
  }
});

it("renders seven days for next week while current week keeps only remaining days", () => {
  const props = { items: [], today: "2026-10-16", timeZone: "Europe/Chisinau" };
  const html = renderToStaticMarkup(
    <RecommendationWeek {...props} kind="next-week" />,
  );
  expect(html).toContain('id="rec-day-2026-10-19"');
  expect(html).toContain('id="rec-day-2026-10-25"');
  expect(html).not.toContain('id="rec-day-2026-10-16"');
  expect((html.match(/id="rec-day-/g) || []).length).toBe(7);
});

it("upgrades the snapshot kind constraint without changing existing payloads or timestamps", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE scopes (id TEXT PRIMARY KEY); INSERT INTO scopes VALUES ('belgrade')",
    );
    db.exec(
      readFileSync(
        new URL("../migrations/034_recommendations.sql", import.meta.url),
        "utf8",
      ),
    );
    db.prepare("INSERT INTO recommendation_snapshots VALUES (?,?,?,?,?)").run(
      "old",
      "belgrade",
      "week",
      '{"preserved":true}',
      "2026-10-15T10:00:00Z",
    );
    const before = db.prepare("SELECT * FROM recommendation_snapshots").all();
    db.exec(
      readFileSync(
        new URL(
          "../migrations/038_recommendation_next_week.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM recommendation_snapshots").all()).toEqual(
      before,
    );
    expect(() =>
      db
        .prepare("INSERT INTO recommendation_snapshots VALUES (?,?,?,?,?)")
        .run("new", "belgrade", "next-week", "{}", "now"),
    ).not.toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO recommendation_snapshots VALUES (?,?,?,?,?)")
        .run("invalid", "belgrade", "month", "{}", "now"),
    ).toThrow();
  } finally {
    db.close();
  }
});

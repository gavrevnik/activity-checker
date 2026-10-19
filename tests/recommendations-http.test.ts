import express from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";
import { registerRecommendationsApi } from "../server/recommendations.js";

it("round-trips recommendations and prompts over guarded HTTP on an isolated database", async () => {
  const store = new Store(":memory:"),
    app = express(),
    server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    app.use(createApi(store, address.port));
    const base = `http://127.0.0.1:${address.port}/api/recommendations`;
    const read = () => fetch(base + "?scopeId=belgrade").then((r) => r.json());
    const mutate = (
      path: string,
      body: unknown,
      method = "POST",
      origin?: string,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
      });
    const initial = await read();
    expect(initial.snapshot).toBeNull();
    const sources = await (
      await fetch(base + "/sources?scopeId=belgrade")
    ).json();
    expect(
      sources.other.some((s: { id: string }) => s.id === "source-meetup"),
    ).toBe(true);
    expect(Array.isArray(sources.telegram)).toBe(true);
    expect((await read()).settings).toEqual(initial.settings);
    expect((await fetch(base + "/sources?scopeId=unknown")).status).toBe(400);
    const personalInput = {
      id: randomUUID(),
      scopeId: "belgrade",
      day: initial.period.endDate,
      hour: 19,
      title: "Личная встреча",
      description: "Подробное описание.",
    };
    expect(
      (await mutate("/personal", personalInput, "POST", "https://example.org"))
        .status,
    ).toBe(403);
    const personal = await (await mutate("/personal", personalInput)).json();
    expect((await read()).personal).toEqual([personal]);
    expect(
      (
        await mutate(
          "/personal/state",
          { scopeId: "serbia", id: personal.id, deleted: true },
          "PUT",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await mutate(
          "/personal/state",
          { scopeId: "belgrade", id: personal.id, deleted: true },
          "PUT",
          "https://example.org",
        )
      ).status,
    ).toBe(403);
    await mutate(
      "/personal/state",
      { scopeId: "belgrade", id: personal.id, deleted: true },
      "PUT",
    );
    expect((await read()).personal[0].deletedAt).toBeTruthy();
    await mutate(
      "/personal/state",
      { scopeId: "belgrade", id: personal.id, deleted: false, favorite: true },
      "PUT",
    );
    expect((await read()).personal[0]).toMatchObject({
      deletedAt: null,
      favorite: true,
    });
    const input = {
      id: randomUUID(),
      scopeId: "belgrade",
      kind: "week",
      ...initial.period,
      requestSummary: "Неделя",
      settingsRevision: initial.settings.revision,
      expectedSnapshotId: null,
      items: [
        {
          title: "Тестовая встреча",
          description: "Описание",
          startAt: initial.period.startDate,
          group: "social",
          aiScore: 8,
          sourceName: "Тестовый канал",
          sourceUrl: "https://t.me/example/123",
        },
      ],
    };
    const saved = await (await mutate("", input)).json();
    expect(saved.updatedAt).toBeTruthy();
    expect((await read()).snapshot).toEqual(saved);
    expect(await (await mutate("", input)).json()).toEqual(saved);
    expect(
      (
        await mutate(
          "/favorite",
          { scopeId: "belgrade", item: saved.items[0], favorite: true },
          "PUT",
          "https://example.org",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await mutate(
          "/favorite",
          { scopeId: "belgrade", item: saved.items[0], favorite: true },
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect((await read()).favorites).toHaveLength(1);
    const withFavorites = await read();
    await fetch(base + "/sources?scopeId=belgrade");
    expect(await read()).toEqual(withFavorites);
    expect((await read()).snapshot.items).toEqual(saved.items);
    expect(
      (
        await mutate(
          "/favorite",
          { scopeId: "belgrade", item: saved.items[0], favorite: false },
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect((await read()).favorites).toHaveLength(0);
    expect((await read()).snapshot.items).toEqual(saved.items);
    const hidden = await (
      await mutate("/hide", { scopeId: "belgrade", item: saved.items[0] })
    ).json();
    expect(hidden.id).toBeTruthy();
    const withHidden = await read();
    await fetch(base + "/sources?scopeId=belgrade");
    expect(await read()).toEqual(withHidden);
    expect((await read()).snapshot.items).toEqual([]);
    expect(
      (await (await fetch(base + "/hidden?scopeId=belgrade")).json()).hidden,
    ).toHaveLength(1);
    const filtered = await (
      await mutate("/filter-candidates", {
        scopeId: "belgrade",
        candidates: saved.items,
      })
    ).json();
    expect(filtered.excludedCount).toBe(1);
    expect(filtered.candidates).toEqual([]);
    const directory = await mkdtemp(join(tmpdir(), "recommendation-filter-"));
    try {
      const candidate = {
        title: saved.items[0].title,
        startAt: saved.items[0].startAt,
        sourceName: saved.items[0].sourceName,
        sourceUrl: saved.items[0].sourceUrl,
      };
      await writeFile(
        join(directory, "input.json"),
        JSON.stringify([
          candidate,
          {
            ...candidate,
            title: "Другая встреча",
            rawText: "Не выводить в stdout",
          },
        ]),
      );
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "scripts/filter-recommendation-candidates.ts",
        join(directory, "input.json"),
        join(directory, "output.json"),
        "belgrade",
        `http://127.0.0.1:${address.port}/api`,
      ]);
      expect(JSON.parse(stdout).excludedCount).toBe(1);
      expect(stdout).not.toContain("Не выводить");
      const eligible = JSON.parse(
        await readFile(join(directory, "output.json"), "utf8"),
      );
      expect(eligible).toHaveLength(1);
      expect(eligible[0].rawText).toBe("Не выводить в stdout");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(
      (await mutate("/restore", { scopeId: "serbia", id: hidden.id })).status,
    ).toBe(400);
    expect(
      (
        await mutate(
          "/restore",
          { scopeId: "belgrade", id: hidden.id },
          "POST",
          "https://example.org",
        )
      ).status,
    ).toBe(403);
    expect(
      (await mutate("/restore", { scopeId: "belgrade", id: hidden.id })).status,
    ).toBe(200);
    expect((await read()).snapshot.items).toEqual(saved.items);
    expect((await mutate("", { ...input, id: randomUUID() })).status).toBe(400);
    expect((await fetch(base + "/schema")).status).toBe(200);
    expect((await fetch(base + "?scopeId=belgrade&kind=other")).status).toBe(
      400,
    );
    expect((await fetch(base + "?scopeId=missing")).status).toBe(400);
    expect(
      (await mutate("", input, "POST", "https://example.org")).status,
    ).toBe(403);
    const settingsInput = {
      expectedRevision: initial.settings.revision,
      prompts: {
        ...initial.settings.prompts,
        social: "Караоке и разговорные клубы",
      },
    };
    const settings = await (
      await mutate("/settings", settingsInput, "PUT")
    ).json();
    expect(settings.revision).toBe(1);
    expect((await read()).settings).toEqual(settings);
    expect((await read()).snapshot).toEqual(saved);
    expect((await mutate("/settings", settingsInput, "PUT")).status).toBe(400);
    expect(
      (
        await mutate("", {
          ...input,
          id: randomUUID(),
          expectedSnapshotId: saved.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await (
          await fetch(base + "?scopeId=belgrade&kind=concerts-2026")
        ).json()
      ).snapshot,
    ).toBeNull();
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

it("serves venue discovery from synthetic Knowledge shards over HTTP without changing recommendation state", async () => {
  const store = new Store(":memory:"),
    root = await mkdtemp(join(tmpdir(), "venue-http-"));
  const dir = join(root, "knowledge/indexes");
  await mkdir(join(dir, "records/source"), { recursive: true });
  const source = {
    id: "test-venue",
    name: "Площадка",
    platform: "web",
    enabled: true,
    locator: "https://venue.example/calendar",
    domains: ["activities"],
    roles: ["venue_event_discovery"],
    record_path: "knowledge/indexes/records/source/test-venue.json",
    access: { method: "web_search", search_domains: ["venue.example"] },
    metadata: {
      city: "Belgrade",
      country: "Serbia",
      source_kind: "venue",
      discovery_priority: "P1",
      event_types: ["live_music", "standup"],
      genres: ["rock"],
      page_type: "official_calendar",
      calendar_availability: "readable",
      checked_on: "2026-10-16",
      pages: [],
    },
  };
  await writeFile(join(dir, "one.jsonl"), "");
  await writeFile(join(dir, "two.jsonl"), JSON.stringify(source));
  await writeFile(
    join(dir, "records/source/test-venue.json"),
    JSON.stringify(source),
  );
  for (const [index, kind, members] of [
    [0, "venues", ["test-venue"]],
    [1, "organizers", []],
  ] as const)
    await writeFile(
      join(dir, `collections-${index}.jsonl`),
      JSON.stringify({
        id: `belgrade-live-${kind}`,
        member_type: "source",
        members,
      }),
    );
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      data_revision: "fixture",
      datasets: {
        sources: {
          paths: ["knowledge/indexes/one.jsonl", "knowledge/indexes/two.jsonl"],
        },
        collections: {
          format: "jsonl",
          paths: [
            "knowledge/indexes/collections-0.jsonl",
            "knowledge/indexes/collections-1.jsonl",
          ],
        },
      },
    }),
  );
  const app = express();
  registerRecommendationsApi(app, store, root);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    const tables = [
      "recommendation_snapshots",
      "recommendation_visibility",
      "recommendation_favorites",
      "recommendation_personal",
    ];
    const state = () =>
      tables.map((table) => store.db.prepare(`SELECT * FROM ${table}`).all());
    const before = state();
    const base = `http://127.0.0.1:${address.port}/api/recommendations/sources?scopeId=`;
    const response = await fetch(base + "belgrade");
    expect(response.status).toBe(200);
    const sources = await response.json();
    expect(sources.venues).toHaveLength(1);
    expect(sources.venues[0]).toMatchObject({
      id: "test-venue",
      venue: { priority: "P1", kind: "venue" },
    });
    expect(sources.venueWarning).toBeNull();
    expect((await (await fetch(base + "serbia")).json()).venues).toEqual([]);
    expect(state()).toEqual(before);
    await rm(join(dir, "records/source/test-venue.json"));
    const broken = await (await fetch(base + "belgrade")).json();
    expect(broken.venueWarning).toBeTruthy();
    expect(broken.other.length).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

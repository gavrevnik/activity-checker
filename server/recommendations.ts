import type { Express } from "express";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { recommendationSearchSources } from "./recommendation-sources.js";
import { fromLocalDateTime, localDay } from "../shared/dates.js";
import {
  defaultRecommendationPrompts,
  personalRecommendationInputSchema,
  type PersonalRecommendation,
  recommendationInputSchema,
  recommendationPeriod,
  recommendationPromptsSchema,
  type RecommendationInput,
  type RecommendationSettings,
  recommendationExpired,
  recommendationDay,
  type RecommendationSnapshot,
  recommendationItemSchema,
  recommendationCandidateSchema,
  recommendationIdentityKeys,
  type HiddenRecommendation,
  type FavoriteRecommendation,
} from "../shared/recommendations.js";

export class Recommendations {
  constructor(private store: Store) {}
  cleanupVisibility(now = new Date(), scopeId?: string) {
    let removed = 0;
    for (const table of [
      "recommendation_visibility",
      "recommendation_favorites",
      "recommendation_personal",
    ]) {
      const rows = this.store.db
        .prepare(
          `SELECT v.id,v.data,s.timezone FROM ${table} v JOIN scopes s ON s.id=v.scopeId` +
            (scopeId ? " WHERE v.scopeId=?" : ""),
        )
        .all(...(scopeId ? [scopeId] : [])) as {
        id: string;
        data: string;
        timezone: string;
      }[];
      const expired = rows.filter((row) =>
        recommendationExpired(JSON.parse(row.data), now, row.timezone),
      );
      this.store.transaction(() => {
        const remove = this.store.db.prepare(`DELETE FROM ${table} WHERE id=?`);
        for (const row of expired) remove.run(row.id);
      });
      removed += expired.length;
    }
    return removed;
  }
  personal(scopeId: string, now = new Date()): PersonalRecommendation[] {
    this.store.scope(scopeId);
    this.cleanupVisibility(now, scopeId);
    return (
      this.store.db
        .prepare(
          "SELECT data FROM recommendation_personal WHERE scopeId=? ORDER BY createdAt,id",
        )
        .all(scopeId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  addPersonal(input: unknown, now = new Date()) {
    const data = personalRecommendationInputSchema.parse(input);
    const timeZone = this.store.scope(data.scopeId).timezone;
    const period = recommendationPeriod("week", localDay(now, timeZone));
    if (data.day < period.startDate || data.day > period.endDate)
      throw Error("Выберите день с сегодняшнего до воскресенья текущей недели");
    const item: PersonalRecommendation = {
      id: data.id,
      group: "personal",
      title: data.title,
      description: data.description,
      startAt: fromLocalDateTime(
        data.day,
        `${String(data.hour).padStart(2, "0")}:00`,
        timeZone,
      ),
      endAt: "",
      sourceName: "Моё событие",
      sourceUrl: "",
      eventUrl: "",
      weekEndDate: period.endDate,
      deletedAt: null,
      favorite: false,
    };
    return this.store.transaction(() => {
      const previous = this.store.db
        .prepare("SELECT scopeId,data FROM recommendation_personal WHERE id=?")
        .get(item.id) as { scopeId: string; data: string } | undefined;
      if (previous) {
        const saved: PersonalRecommendation = JSON.parse(previous.data);
        if (
          previous.scopeId !== data.scopeId ||
          saved.title !== item.title ||
          saved.description !== item.description ||
          saved.startAt !== item.startAt
        )
          throw Error("ID уже занят другим событием");
        return saved; // A retried create must not undo deletion or favorite state.
      }
      this.store.db
        .prepare(
          "INSERT INTO recommendation_personal(id,scopeId,data,createdAt) VALUES (?,?,?,?)",
        )
        .run(item.id, data.scopeId, JSON.stringify(item), now.toISOString());
      return item;
    });
  }
  updatePersonal(input: unknown, now = new Date()) {
    const data = z
      .object({
        scopeId: z.string().min(1),
        id: z.uuid(),
        deleted: z.boolean().optional(),
        favorite: z.boolean().optional(),
      })
      .strict()
      .refine(
        (d) => d.deleted !== undefined || d.favorite !== undefined,
        "Не указано изменение события",
      )
      .parse(input);
    return this.store.transaction(() => {
      const item = this.personal(data.scopeId, now).find(
        (row) => row.id === data.id,
      );
      if (!item)
        throw Error("Личное событие не найдено или неделя завершилась");
      if (data.deleted !== undefined)
        item.deletedAt = data.deleted
          ? item.deletedAt || now.toISOString()
          : null;
      if (data.favorite !== undefined) item.favorite = data.favorite;
      this.store.db
        .prepare(
          "UPDATE recommendation_personal SET data=? WHERE id=? AND scopeId=?",
        )
        .run(JSON.stringify(item), data.id, data.scopeId);
      return item;
    });
  }
  favorites(scopeId: string, now = new Date()): FavoriteRecommendation[] {
    this.store.scope(scopeId);
    this.cleanupVisibility(now, scopeId);
    return (
      this.store.db
        .prepare(
          "SELECT id,data,addedAt FROM recommendation_favorites WHERE scopeId=? ORDER BY addedAt DESC,rowid DESC",
        )
        .all(scopeId) as { id: string; data: string; addedAt: string }[]
    ).map(({ data, ...row }) => ({
      ...row,
      item: recommendationItemSchema.parse(JSON.parse(data)),
    }));
  }
  saveFavorite(input: unknown, now = new Date()) {
    const { scopeId, item, favorite } = z
      .object({
        scopeId: z.string().min(1),
        item: recommendationItemSchema,
        favorite: z.boolean(),
      })
      .strict()
      .parse(input);
    const timeZone = this.store.scope(scopeId).timezone;
    if (favorite && recommendationExpired(item, now, timeZone))
      throw Error("Событие уже прошло");
    return this.store.transaction(() => {
      const keys = new Set(recommendationIdentityKeys(item, timeZone));
      const matches = this.favorites(scopeId, now).filter((row) =>
        recommendationIdentityKeys(row.item, timeZone).some((key) =>
          keys.has(key),
        ),
      );
      if (!favorite) {
        const remove = this.store.db.prepare(
          "DELETE FROM recommendation_favorites WHERE id=? AND scopeId=?",
        );
        for (const row of matches) remove.run(row.id, scopeId);
      } else {
        const previous = matches[0];
        this.store.db
          .prepare(
            "INSERT INTO recommendation_favorites(id,scopeId,data,addedAt) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          )
          .run(
            previous?.id || randomUUID(),
            scopeId,
            JSON.stringify(item),
            previous?.addedAt || now.toISOString(),
          );
      }
      return { favorite };
    });
  }
  private visibility(scopeId: string, now: Date) {
    this.store.scope(scopeId);
    this.cleanupVisibility(now, scopeId);
    return (
      this.store.db
        .prepare(
          "SELECT id,data,hidden,hiddenAt FROM recommendation_visibility WHERE scopeId=? ORDER BY hiddenAt DESC,rowid DESC",
        )
        .all(scopeId) as {
        id: string;
        data: string;
        hidden: number;
        hiddenAt: string;
      }[]
    ).map(({ data, ...row }) => ({
      ...row,
      item: recommendationItemSchema.parse(JSON.parse(data)),
    }));
  }
  hidden(scopeId: string, now = new Date()): HiddenRecommendation[] {
    return this.visibility(scopeId, now)
      .filter((row) => row.hidden === 1)
      .map(({ hidden: _, ...row }) => row);
  }
  hide(input: unknown, now = new Date()) {
    const { scopeId, item } = z
      .object({ scopeId: z.string().min(1), item: recommendationItemSchema })
      .strict()
      .parse(input);
    const timeZone = this.store.scope(scopeId).timezone;
    if (recommendationExpired(item, now, timeZone))
      throw Error("Событие уже прошло");
    return this.store.transaction(() => {
      const keys = new Set(recommendationIdentityKeys(item, timeZone));
      const previous = this.visibility(scopeId, now).find((row) =>
        recommendationIdentityKeys(row.item, timeZone).some((key) =>
          keys.has(key),
        ),
      );
      const id = previous?.id || randomUUID();
      const hiddenAt = now.toISOString();
      this.store.db
        .prepare(
          "INSERT INTO recommendation_visibility(id,scopeId,data,hidden,hiddenAt) VALUES (?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,hidden=1,hiddenAt=excluded.hiddenAt",
        )
        .run(id, scopeId, JSON.stringify(item), hiddenAt);
      return { id, item, hiddenAt };
    });
  }
  restore(input: unknown, now = new Date()) {
    const { scopeId, id } = z
      .object({ scopeId: z.string().min(1), id: z.uuid() })
      .strict()
      .parse(input);
    this.store.scope(scopeId);
    this.cleanupVisibility(now, scopeId);
    // Keep a restored card until expiry, so it can return even after a newer snapshot omitted it.
    const result = this.store.db
      .prepare(
        "UPDATE recommendation_visibility SET hidden=0 WHERE scopeId=? AND id=?",
      )
      .run(scopeId, id);
    if (!result.changes)
      throw Error("Скрытое событие не найдено или уже прошло");
    return { restored: true };
  }
  filterCandidates(input: unknown, now = new Date()) {
    const { scopeId, candidates } = z
      .object({
        scopeId: z.string().min(1),
        candidates: z.array(recommendationCandidateSchema).max(2000),
      })
      .strict()
      .parse(input);
    const timeZone = this.store.scope(scopeId).timezone;
    const hidden = this.hidden(scopeId, now);
    const keys = new Set(
      hidden.flatMap((row) => recommendationIdentityKeys(row.item, timeZone)),
    );
    const eligible = candidates.filter(
      (item) =>
        !recommendationIdentityKeys(item, timeZone).some((key) =>
          keys.has(key),
        ),
    );
    return {
      candidates: eligible,
      excludedCount: candidates.length - eligible.length,
      hiddenCount: hidden.length,
    };
  }
  private project(
    snapshot: RecommendationSnapshot | null,
    now: Date,
    visibility: ReturnType<Recommendations["visibility"]>,
  ) {
    if (!snapshot) return null;
    const timeZone = this.store.scope(snapshot.scopeId).timezone;
    const today = localDay(now, timeZone);
    const period = recommendationPeriod(snapshot.kind, today);
    const hiddenKeys = new Set(
      visibility
        .filter((row) => row.hidden === 1)
        .flatMap((row) => recommendationIdentityKeys(row.item, timeZone)),
    );
    const visible = (item: RecommendationSnapshot["items"][number]) =>
      recommendationDay(item.startAt, timeZone) >= today &&
      recommendationDay(item.startAt, timeZone) <= period.endDate &&
      (snapshot.kind === "week" || item.group === "concerts") &&
      !recommendationExpired(item, now, timeZone) &&
      !recommendationIdentityKeys(item, timeZone).some((key) =>
        hiddenKeys.has(key),
      );
    const items = snapshot.items.filter(visible);
    const keys = new Set(
      items.flatMap((item) => recommendationIdentityKeys(item, timeZone)),
    );
    for (const row of [
      ...visibility.filter((row) => row.hidden === 0),
      ...this.favorites(snapshot.scopeId, now),
    ]) {
      if (
        visible(row.item) &&
        !recommendationIdentityKeys(row.item, timeZone).some((key) =>
          keys.has(key),
        )
      ) {
        items.push(row.item);
        for (const key of recommendationIdentityKeys(row.item, timeZone))
          keys.add(key);
      }
    }
    return { ...snapshot, items };
  }
  settings(): RecommendationSettings {
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key='recommendation-prompts'")
      .get() as { value: string } | undefined;
    return row
      ? JSON.parse(row.value)
      : { revision: 0, prompts: { ...defaultRecommendationPrompts } };
  }
  saveSettings(input: unknown) {
    const data = z
      .object({
        expectedRevision: z.number().int().min(0),
        prompts: recommendationPromptsSchema,
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const previous = this.settings();
      if (previous.revision !== data.expectedRevision)
        throw Error("Промпты изменились; перечитайте настройки");
      const next = { revision: previous.revision + 1, prompts: data.prompts };
      this.store.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES ('recommendation-prompts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(next));
      return next;
    });
  }
  private hydrate(row?: { data: string; updatedAt: string }) {
    return row
      ? {
          ...recommendationInputSchema.parse(JSON.parse(row.data)),
          updatedAt: row.updatedAt,
        }
      : null;
  }
  latest(scopeId: string, kind: RecommendationInput["kind"]) {
    this.store.scope(scopeId);
    return this.hydrate(
      this.store.db
        .prepare(
          "SELECT data,updatedAt FROM recommendation_snapshots WHERE scopeId=? AND kind=? ORDER BY updatedAt DESC,rowid DESC LIMIT 1",
        )
        .get(scopeId, kind) as { data: string; updatedAt: string } | undefined,
    );
  }
  view(scopeId: string, kind: RecommendationInput["kind"], now = new Date()) {
    const timeZone = this.store.scope(scopeId).timezone;
    return {
      settings: this.settings(),
      snapshot: this.project(
        this.latest(scopeId, kind),
        now,
        this.visibility(scopeId, now),
      ),
      hidden: this.hidden(scopeId, now),
      favorites: this.favorites(scopeId, now),
      personal: this.personal(scopeId, now),
      timeZone,
      period: recommendationPeriod(kind, localDay(now, timeZone)),
    };
  }
  publish(input: unknown, now = new Date()): RecommendationSnapshot {
    const data = recommendationInputSchema.parse(input);
    const timeZone = this.store.scope(data.scopeId).timezone;
    return this.store.transaction(() => {
      const existing = this.hydrate(
        this.store.db
          .prepare(
            "SELECT data,updatedAt FROM recommendation_snapshots WHERE id=?",
          )
          .get(data.id) as { data: string; updatedAt: string } | undefined,
      );
      if (existing) {
        const { updatedAt: _, ...payload } = existing;
        if (!isDeepStrictEqual(payload, data))
          throw Error("ID уже занят другой подборкой");
        return this.project(existing, now, this.visibility(data.scopeId, now))!;
      }
      if (this.settings().revision !== data.settingsRevision)
        throw Error("Промпты изменились; пересмотрите подборку");
      if (
        (this.latest(data.scopeId, data.kind)?.id ?? null) !==
        data.expectedSnapshotId
      )
        throw Error("Рекомендации изменились; перечитайте подборку");
      const today = localDay(now, timeZone);
      const period = recommendationPeriod(data.kind, today);
      if (
        data.startDate !== period.startDate ||
        data.endDate !== period.endDate
      )
        throw Error("Период изменился; перечитайте текущие даты");
      if (
        data.items.some(
          (item) =>
            recommendationDay(item.startAt, timeZone) < data.startDate ||
            recommendationDay(item.startAt, timeZone) > data.endDate ||
            recommendationExpired(item, now, timeZone) ||
            (data.kind === "concerts-2026" && item.group !== "concerts"),
        )
      )
        throw Error("Событие вне периода или группы рекомендаций");
      const keys = data.items.map(
        (item) =>
          `${item.eventUrl || item.sourceUrl}|${item.startAt}|${item.title.trim().toLowerCase()}`,
      );
      if (new Set(keys).size !== keys.length)
        throw Error("Подборка содержит повторные события");
      const stamp = now.toISOString();
      this.store.db
        .prepare(
          "INSERT INTO recommendation_snapshots(id,scopeId,kind,data,updatedAt) VALUES (?,?,?,?,?)",
        )
        .run(data.id, data.scopeId, data.kind, JSON.stringify(data), stamp);
      return this.project(
        { ...data, updatedAt: stamp },
        now,
        this.visibility(data.scopeId, now),
      )!;
    });
  }
}
export function registerRecommendationsApi(app: Express, store: Store) {
  const service = new Recommendations(store);
  app.get("/api/recommendations", (req, res) => {
    const query = z
      .object({
        scopeId: z.string().min(1),
        kind: z.enum(["week", "concerts-2026"]).default("week"),
      })
      .parse(req.query);
    res.json(service.view(query.scopeId, query.kind));
  });
  app.get("/api/recommendations/schema", (_req, res) =>
    res.json(z.toJSONSchema(recommendationInputSchema, { io: "input" })),
  );
  app.get("/api/recommendations/hidden", (req, res) => {
    const scopeId = z.string().min(1).parse(req.query.scopeId);
    res.json({ hidden: service.hidden(scopeId) });
  });
  app.post("/api/recommendations/personal", (req, res) =>
    res.json(service.addPersonal(req.body)),
  );
  app.put("/api/recommendations/personal/state", (req, res) =>
    res.json(service.updatePersonal(req.body)),
  );
  app.post("/api/recommendations/hide", (req, res) =>
    res.json(service.hide(req.body)),
  );
  app.put("/api/recommendations/favorite", (req, res) =>
    res.json(service.saveFavorite(req.body)),
  );
  app.post("/api/recommendations/restore", (req, res) =>
    res.json(service.restore(req.body)),
  );
  app.post("/api/recommendations/filter-candidates", (req, res) =>
    res.json(service.filterCandidates(req.body)),
  );
  app.get("/api/recommendations/sources", (req, res) => {
    const scopeId = z.string().min(1).parse(req.query.scopeId);
    const items = [
      service.latest(scopeId, "week"),
      service.latest(scopeId, "concerts-2026"),
    ].flatMap((snapshot) => snapshot?.items || []);
    res.json(recommendationSearchSources(store, scopeId, items));
  });
  app.put("/api/recommendations/settings", (req, res) =>
    res.json(service.saveSettings(req.body)),
  );
  app.post("/api/recommendations", (req, res) =>
    res.json(service.publish(req.body)),
  );
}

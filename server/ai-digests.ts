import type { Express } from "express";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { Store } from "./store.js";
import { localDay } from "../shared/dates.js";
import {
  aiDigestInputSchema,
  digestItemSchema,
  digestTagsSchema,
  validateDigestPeriod,
  type AiDigest,
  type AiDigestInput,
} from "../shared/ai-digests.js";

type Row = { data: string; createdAt: string; archivedAt: string | null };
const hydrate = (row: Row): AiDigest => ({
  ...aiDigestInputSchema.parse(JSON.parse(row.data)),
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});
export class AiDigests {
  constructor(private store: Store) {}
  remove(id: string, input: unknown) {
    const { expectedDigest } = z
      .object({
        expectedDigest: aiDigestInputSchema.safeExtend({
          createdAt: z.iso.datetime(),
          archivedAt: z.iso.datetime().nullable(),
        }),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const current = this.get(id);
      if (!current) return null;
      if (!isDeepStrictEqual(current, expectedDigest))
        throw new Error("Дайджест изменился; перечитайте его перед удалением");
      this.store.db.prepare("DELETE FROM ai_digests WHERE id=?").run(id);
      return { deleted: true as const, id };
    });
  }
  updateTags(id: string, input: unknown) {
    const patch = z
      .object({
        expectedItems: z.array(digestItemSchema).max(100),
        tags: z.array(digestTagsSchema).max(100),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const digest = this.get(id);
      if (!digest) throw new Error("Дайджест не найден");
      if (JSON.stringify(digest.items) !== JSON.stringify(patch.expectedItems))
        throw new Error(
          "События изменились; перечитайте дайджест перед разметкой тегов",
        );
      if (patch.tags.length !== digest.items.length)
        throw new Error("Нужны теги для каждой строки");
      const {
        createdAt: _createdAt,
        archivedAt: _archivedAt,
        ...data
      } = digest;
      data.items = data.items.map((item, index) => ({
        ...item,
        tags: patch.tags[index],
      }));
      this.store.db
        .prepare("UPDATE ai_digests SET data=? WHERE id=?")
        .run(JSON.stringify(data), id);
      return this.get(id)!;
    });
  }
  get(id: string) {
    const row = this.store.db
      .prepare("SELECT data,createdAt,archivedAt FROM ai_digests WHERE id=?")
      .get(id) as Row | undefined;
    return row ? hydrate(row) : null;
  }
  create(input: unknown, now = new Date()) {
    const data = aiDigestInputSchema.parse(input);
    const scope = this.store.scope(data.scopeId);
    validateDigestPeriod(data, scope.timezone);
    return this.store.transaction(() => {
      const previous = this.get(data.id);
      if (previous) {
        const {
          createdAt: _createdAt,
          archivedAt: _archivedAt,
          ...snapshot
        } = previous;
        if (JSON.stringify(snapshot) !== JSON.stringify(data))
          throw new Error(
            "Этот ID уже занят другим дайджестом; для новой подборки используйте новый UUID",
          );
        return previous;
      }
      const stamp = now.toISOString();
      this.store.db
        .prepare("INSERT INTO ai_digests VALUES (?,?,?,?,?,?,?)")
        .run(
          data.id,
          data.scopeId,
          data.startDate,
          data.endDate,
          JSON.stringify(data),
          stamp,
          data.endDate < localDay(now, scope.timezone) ? stamp : null,
        );
      return this.get(data.id)!;
    });
  }
  list(scopeId: string, archived: boolean) {
    const scope = this.store.scope(scopeId);
    return (
      this.store.db
        .prepare(
          `SELECT d.data,d.createdAt,d.archivedAt FROM ai_digests d JOIN scopes s ON s.id=d.scopeId WHERE s.country=? AND (? IS NULL OR s.id=?) AND d.archivedAt IS ${archived ? "NOT NULL" : "NULL"} ORDER BY d.endDate DESC,d.startDate DESC,d.createdAt DESC,d.id`,
        )
        .all(scope.country, scope.city, scopeId) as Row[]
    ).map(hydrate);
  }
  archivePast(scopeId: string, today?: string) {
    const scope = this.store.scope(scopeId);
    const cutoffDate = today || localDay(new Date(), scope.timezone);
    const result = this.store.db
      .prepare(
        "UPDATE ai_digests SET archivedAt=? WHERE archivedAt IS NULL AND endDate < ? AND scopeId IN (SELECT id FROM scopes WHERE country=? AND (? IS NULL OR id=?))",
      )
      .run(
        new Date().toISOString(),
        cutoffDate,
        scope.country,
        scope.city,
        scopeId,
      );
    return { archived: Number(result.changes), cutoffDate };
  }
}
export function registerAiDigestsApi(app: Express, store: Store) {
  const digests = new AiDigests(store);
  app.get("/api/ai-digests", (req, res) => {
    const q = z
      .object({
        scopeId: z.string().min(1),
        archived: z.enum(["true", "false"]).default("false"),
      })
      .parse(req.query);
    res.json({ digests: digests.list(q.scopeId, q.archived === "true") });
  });
  app.get("/api/ai-digests/schema", (_req, res) =>
    res.json(z.toJSONSchema(aiDigestInputSchema, { io: "input" })),
  );
  app.get("/api/ai-digests/:id", (req, res) => {
    const digest = digests.get(req.params.id);
    if (!digest) return res.status(404).json({ error: "Дайджест не найден" });
    res.json(digest);
  });
  app.post("/api/ai-digests", (req, res) => res.json(digests.create(req.body)));
  app.delete("/api/ai-digests/:id", (req, res) => {
    const result = digests.remove(req.params.id, req.body);
    if (!result) return res.status(404).json({ error: "Дайджест не найден" });
    res.json(result);
  });
  app.patch("/api/ai-digests/:id/tags", (req, res) => {
    if (!digests.get(req.params.id))
      return res.status(404).json({ error: "Дайджест не найден" });
    res.json(digests.updateTags(req.params.id, req.body));
  });
  app.post("/api/ai-digests/archive-past", (req, res) =>
    res.json(
      digests.archivePast(
        z
          .object({ scopeId: z.string().min(1) })
          .strict()
          .parse(req.body).scopeId,
      ),
    ),
  );
}

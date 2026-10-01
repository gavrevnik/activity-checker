import express from "express";
import { z, ZodError } from "zod";
import {
  entitySchema,
  filteringRulesSchema,
  importSchema,
  sourceSchema,
  userProfileSchema,
} from "../shared/model.js";
import type { Store } from "./store.js";
import { SyncService } from "./sync.js";
import { providers, providerInfo } from "./providers/registry.js";
import { importEntities } from "./import.js";
import { safeError } from "./secrets.js";
export function createApi(store: Store, port: number) {
  const app = express();
  const sync = new SyncService(store);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const allowedHosts = [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      "activity-checker.localhost",
    ];
    const allowedOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://activity-checker.localhost",
    ];
    if (!allowedHosts.includes(req.headers.host || ""))
      return res.status(403).json({ error: "Недопустимый Host" });
    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (
      !safeMethod &&
      ((req.headers.origin && !allowedOrigins.includes(req.headers.origin)) ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return res.status(403).json({ error: "Запрос с другого сайта отклонён" });
    if (!safeMethod && !req.is("application/json"))
      return res
        .status(415)
        .json({ error: "Ожидается Content-Type: application/json" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "5mb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/bootstrap", (_req, res) =>
    res.json({
      scopes: store.scopes(),
      providers: providers.map(providerInfo),
      sources: sync.views(),
      candidates: store.candidates(),
      entities: store.entities(),
      runs: sync.runs(),
      profile: store.profile(),
      filterRules: store.filterRulesView(),
    }),
  );
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, app: "activity-checker" }),
  );
  app.get("/api/entities/:id", (req, res) =>
    res.json(store.entity(req.params.id)),
  );
  app.post("/api/entities/archive-past", (req, res) =>
    res.json(
      store.archivePastEvents(
        z
          .object({ scopeId: z.string().min(1) })
          .strict()
          .parse(req.body).scopeId,
      ),
    ),
  );
  app.get("/api/profile", (_req, res) => res.json(store.profile()));
  app.put("/api/profile", (req, res) =>
    res.json(store.saveProfile(userProfileSchema.parse(req.body))),
  );
  app.get("/api/filter-rules", (_req, res) =>
    res.json(store.filterRulesView()),
  );
  app.put("/api/filter-rules", (req, res) =>
    res.json(store.saveFilterRules(filteringRulesSchema.parse(req.body))),
  );
  app.post("/api/entities", (req, res) => {
    const entity = entitySchema.parse(req.body);
    res.json(importEntities(store, { entities: [entity] }));
  });
  app.put("/api/entities/:id", (req, res) =>
    res.json(store.editEntity(req.params.id, entitySchema.parse(req.body))),
  );
  app.patch("/api/entities/:id", (req, res) =>
    res.json(
      store.setState(
        req.params.id,
        z
          .object({
            archived: z.boolean().optional(),
            favorite: z.boolean().optional(),
            notes: z.string().max(10000).optional(),
          })
          .strict()
          .parse(req.body),
      ),
    ),
  );
  app.post("/api/entities/:id/merge", (req, res) =>
    res.json(
      store.merge(
        req.params.id,
        z.object({ removeId: z.string() }).parse(req.body).removeId,
      ),
    ),
  );
  app.post("/api/entities/:id/duplicates/ignore", (req, res) => {
    store.ignoreDuplicate(
      req.params.id,
      z.object({ otherId: z.string() }).parse(req.body).otherId,
    );
    res.json({ ok: true });
  });
  app.post("/api/entities/:id/relations", (req, res) => {
    const b = z
      .object({
        toId: z.string(),
        relation: z.enum(["organizes", "hosts", "recommends", "associated"]),
        remove: z.boolean().optional(),
      })
      .parse(req.body);
    store.relate(req.params.id, b.toId, b.relation, b.remove);
    res.json(store.entity(req.params.id));
  });
  app.post("/api/import/preview", (req, res) =>
    res.json(importEntities(store, req.body.text ?? req.body, true)),
  );
  app.post("/api/import", (req, res) =>
    res.json(importEntities(store, req.body.text ?? req.body)),
  );
  app.get("/api/import/schema", (_req, res) =>
    res.json(
      z.toJSONSchema(importSchema, { io: "input", unrepresentable: "any" }),
    ),
  );
  app.post("/api/sources", (req, res) =>
    res.json(store.saveSource(sourceSchema.parse(req.body))),
  );
  app.put("/api/sources/:id", (req, res) =>
    res.json(store.saveSource(sourceSchema.parse(req.body), req.params.id)),
  );
  app.post("/api/sources/:id/test", async (req, res) =>
    res.json(await sync.run(req.params.id, true)),
  );
  app.post("/api/sources/:id/sync-plan", async (req, res) =>
    res.json(await sync.plan(req.params.id, req.body)),
  );
  app.post("/api/sources/:id/sync", async (req, res) =>
    res.json(await sync.run(req.params.id, false, req.body)),
  );
  app.post("/api/sync", async (req, res) =>
    res.json(
      await sync.all(z.object({ scopeId: z.string() }).parse(req.body).scopeId),
    ),
  );
  app.post("/api/candidates/:id", (req, res) =>
    res.json({
      source: store.candidateAction(
        req.params.id,
        z.object({ action: z.enum(["accept", "ignore"]) }).parse(req.body)
          .action,
      ),
      ok: true,
    }),
  );
  app.delete("/api/demo", (_req, res) => {
    store.deleteDemo();
    res.json({ ok: true });
  });
  app.get("/api/export", (_req, res) => {
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="activity-export.json"',
    );
    res.json({
      version: 1,
      entities: store
        .entities()
        .map((e) =>
          entitySchema.parse(
            Object.fromEntries(
              Object.keys(entitySchema.shape).map((k) => [k, (e as any)[k]]),
            ),
          ),
        ),
    });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route не найден" }),
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message =
        err instanceof ZodError
          ? err.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("\n")
          : safeError(err);
      res.status(400).json({ error: message });
    },
  );
  return app;
}

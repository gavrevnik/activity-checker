import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./store.js";
import {
  catalogStatus,
  catalogLinks,
  setCatalogInterest,
} from "../../personal-radar/catalog_sync/node.js";
export function registerCatalogApi(app: Express, store: Store) {
  app.get("/api/catalog", (_req, res) =>
    res.json({ ...catalogStatus(store.db), links: catalogLinks(store.db) }),
  );
  app.patch("/api/catalog/:type/:id/interest", (req, res, next) => {
    try {
      const args = z
        .object({ interest: z.enum(["low", "medium", "high"]).nullable() })
        .strict()
        .parse(req.body);
      res.json(
        setCatalogInterest(
          store.db,
          String(req.params.type),
          String(req.params.id),
          args.interest,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
}

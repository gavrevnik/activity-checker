import type { Express } from "express";
import { z } from "zod";
import { publicChannelSchema } from "@personal-radar/connectors/telegram";
import type { Store } from "./store.js";
import {
  executeTelegramBatchRead,
  getTelegramBatchResult,
} from "./providers/telegram/batch.js";
export function registerTelegramBatchApi(app: Express, store: Store) {
  app.post("/api/telegram/batch-read", async (req, res, next) => {
    try {
      res.json(await executeTelegramBatchRead(req.body, store));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/telegram/batches/:requestId", async (req, res, next) => {
    try {
      const input = z
        .object({
          requestId: z.uuid(),
          source: publicChannelSchema.optional(),
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(100),
        })
        .parse({ requestId: req.params.requestId, ...req.query });
      res.json(await getTelegramBatchResult(input, store));
    } catch (error) {
      next(error);
    }
  });
}

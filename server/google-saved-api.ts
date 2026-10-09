import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./store.js";
import {
  parseSavedArchive,
  importSavedItems,
  savedListsStatus,
} from "./google-saved.js";
export function registerGoogleSavedApi(app: Express, store: Store) {
  let busy = false;
  app.get("/api/google-saved/status", (_req, res) =>
    res.json(savedListsStatus(store)),
  );
  app.get("/api/google-saved/items", (req, res) => {
    const input = z
      .object({
        query: z.string().max(200).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(req.query);
    if (!input.success) {
      res.status(400).json({ error: "Некорректный поиск" });
      return;
    }
    const { query, limit } = input.data;
    const items = store.db
      .prepare(
        "SELECT collection,title,note,url,tags,comment,placeId,cid,address,latitude,longitude FROM google_saved_items WHERE instr(lower(title),lower(?))>0 OR instr(lower(collection),lower(?))>0 ORDER BY collection,title LIMIT ?",
      )
      .all(query, query, limit);
    res.json({ items });
  });
  app.post("/api/google-saved/import", async (req, res) => {
    if (busy) {
      res.status(409).json({ error: "Импорт списков Google уже выполняется." });
      return;
    }
    busy = true;
    try {
      const input = z
        .object({
          filename: z.string().min(1).max(500),
          base64: z
            .string()
            .min(1)
            .max(70 * 1024 * 1024)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .strict()
        .parse(req.body);
      const items = await parseSavedArchive(
        Buffer.from(input.base64, "base64"),
        input.filename,
      );
      res.json(importSavedItems(store, items, "manual-takeout"));
    } catch {
      res
        .status(400)
        .json({
          error:
            "Не удалось импортировать списки: выберите ZIP только с «Сохранённым», отдельный CSV или Maps GeoJSON. Лимит файла — 50 МБ, распакованных данных — 50 МБ, записей — 20 000. Существующий индекс сохранён.",
        });
    } finally {
      busy = false;
    }
  });
}

import { importSchema } from "../shared/model.js";
import { digest } from "./normalize.js";
import type { Store } from "./store.js";
export function parseImport(body: unknown) {
  let value = body;
  if (typeof value === "string") {
    value = value
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      value = JSON.parse(value as string);
    } catch {
      throw new Error(
        'Невалидный JSON. Вставьте массив или объект {"entities": [...]}',
      );
    }
  }
  return importSchema.parse(Array.isArray(value) ? { entities: value } : value);
}
export function importEntities(store: Store, body: unknown, preview = false) {
  const batch = parseImport(body);
  const source = store.source("source-manual");
  const records = batch.entities.map((e) => ({
    entity: e,
    raw: {
      externalId: e.externalId || digest(e),
      url: e.url,
      rawText: e.description,
      payload: e,
    },
  }));
  return {
    result: store.ingest(source, records, preview),
    entities: batch.entities.slice(0, 25),
    total: batch.entities.length,
  };
}

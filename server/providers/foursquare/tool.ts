import { z } from "zod";
import { entitySchema } from "../../../shared/model.js";
import { readSecrets } from "../../secrets.js";
import { searchFoursquarePlaces } from "./client.js";
import { foursquareRawItem } from "./provider.js";
import { foursquareQuotaStatus } from "./quota.js";

export const foursquareToolInputSchema = z
  .object({
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    near: z.string().trim().min(1).max(200).default("Belgrade, Serbia"),
    resultsPerQuery: z.number().int().min(1).max(50).default(10),
    maxItems: z.number().int().min(1).max(500).default(100),
    execute: z.boolean().default(false),
    store: z.boolean().default(false),
    sourceId: z.string().min(1).max(200).default("source-foursquare"),
  })
  .strict();

function apiKey() {
  const value = readSecrets().FOURSQUARE_API_KEY;
  if (!value) throw new Error("FOURSQUARE_API_KEY не найден в .env.local.");
  return value;
}

export function getFoursquareToolStatus() {
  return {
    ok: true,
    keyConfigured: Boolean(readSecrets().FOURSQUARE_API_KEY),
    quota: foursquareQuotaStatus(),
    note: "Статус не расходует Foursquare API quota.",
  };
}

export async function executeFoursquareTool(
  input: z.input<typeof foursquareToolInputSchema>,
) {
  const args = foursquareToolInputSchema.parse(input);
  const quotaBefore = foursquareQuotaStatus();
  const plan = {
    requestCount: args.queries.length,
    near: args.near,
    resultsPerQuery: args.resultsPerQuery,
    maxItems: Math.min(
      args.maxItems,
      args.queries.length * args.resultsPerQuery,
    ),
    quotaBefore,
  };
  if (!args.execute) {
    if (args.store)
      throw new Error("store=true доступен только вместе с execute=true.");
    return { mode: "dry-run" as const, plan, results: [], stored: null };
  }
  if (args.queries.length > quotaBefore.remaining)
    throw new Error(
      `Для плана нужно ${args.queries.length} запросов, локально осталось ${quotaBefore.remaining}.`,
    );
  const found = new Map<
    string,
    {
      place: Awaited<
        ReturnType<typeof searchFoursquarePlaces>
      >["places"][number];
      matchedQueries: string[];
    }
  >();
  for (const query of args.queries) {
    const result = await searchFoursquarePlaces({
      query,
      near: args.near,
      limit: args.resultsPerQuery,
      apiKey: apiKey(),
    });
    for (const place of result.places) {
      const existing = found.get(place.fsq_place_id);
      if (existing) existing.matchedQueries.push(query);
      else found.set(place.fsq_place_id, { place, matchedQueries: [query] });
      if (found.size >= plan.maxItems) break;
    }
    if (found.size >= plan.maxItems) break;
  }
  const results = [...found.values()];
  let stored = null;
  if (args.store) {
    const { Store } = await import("../../store.js");
    const store = new Store();
    try {
      const source = store.source(args.sourceId);
      if (source.providerId !== "foursquare")
        throw new Error("sourceId должен указывать на Foursquare source.");
      const ctx = {
        source,
        scope: store.scope(source.scopeId),
        secrets: { FOURSQUARE_API_KEY: apiKey() },
      };
      stored = store.ingest(
        source,
        results.map(({ place, matchedQueries }) => {
          const raw = foursquareRawItem({ ...place, matchedQueries }, ctx);
          return {
            raw,
            entity: entitySchema.parse(
              (raw.payload as { normalized: unknown }).normalized,
            ),
          };
        }),
      );
    } finally {
      store.close();
    }
  }
  return {
    mode: "executed" as const,
    plan,
    results,
    quotaAfter: foursquareQuotaStatus(),
    stored,
  };
}

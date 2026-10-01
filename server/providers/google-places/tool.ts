import { z } from "zod";
import { entitySchema, type Entity } from "../../../shared/model.js";
import { readSecrets } from "../../secrets.js";
import { Store } from "../../store.js";
import {
  executeGooglePlacesBatch,
  executeGooglePlacesDiscovery,
  googlePlaceEntityId,
  normalizeGooglePlacesQueries,
} from "./discovery.js";
import { googlePlacesFieldMasks, type GooglePlace } from "./client.js";
import { googlePlacesRawItem } from "./provider.js";
import { googlePlacesQuotaStatus, type GooglePlacesSku } from "./quota.js";

const commonSchema = {
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  location: z.string().trim().min(1).max(200).optional(),
  minRating: z.number().min(0).max(5).multipleOf(0.5).optional(),
  resultsPerQuery: z.number().int().min(1).max(20).default(10),
  maxItems: z.number().int().min(1).max(500).default(100),
  execute: z.boolean().default(false),
  sourceId: z.string().min(1).max(200).default("source-google-places-api"),
};

export const googlePlacesTierToolSchema = z
  .object({
    ...commonSchema,
    confirmEnterprise: z.boolean().default(false),
  })
  .strict();

export const googlePlacesDiscoveryToolSchema = z
  .object({
    ...commonSchema,
    minValidResultsPerQuery: z.number().int().min(1).max(20).default(1),
  })
  .strict();

const llmRatingItemSchema = z
  .object({
    placeId: z.string().trim().min(1).max(500),
    rating: z.number().min(0).max(5).optional(),
    reviewCount: z.number().int().min(0).optional(),
    source: z.string().trim().min(1).max(2000).default("LLM web research"),
    checkedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (value) => value.rating !== undefined || value.reviewCount !== undefined,
    "Нужен rating и/или reviewCount.",
  );

export const googlePlacesLlmRatingsToolSchema = z
  .object({
    items: z.array(llmRatingItemSchema).min(1).max(100),
  })
  .strict();

function key() {
  const value = readSecrets().GOOGLE_PLACES_API_KEY;
  if (!value) throw new Error("GOOGLE_PLACES_API_KEY не найден в .env.local.");
  return value;
}

function sourceContext(store: Store, sourceId: string) {
  const source = store.source(sourceId);
  if (source.providerId !== "google-places-api")
    throw new Error("sourceId должен указывать на Google Places API (New).");
  const scope = store.scope(source.scopeId);
  return {
    source,
    scope,
    secrets: { GOOGLE_PLACES_API_KEY: readSecrets().GOOGLE_PLACES_API_KEY },
    store,
  };
}

function compact(place: GooglePlace) {
  return {
    id: place.id,
    displayName: place.displayName?.text || null,
    formattedAddress: place.formattedAddress || null,
    location: place.location || null,
    googleMapsUri: place.googleMapsUri || null,
    primaryType: place.primaryType || null,
    types: place.types || [],
    businessStatus: place.businessStatus || null,
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    websiteUri: place.websiteUri || null,
  };
}

function entityInput(entity: Entity) {
  return Object.fromEntries(
    Object.keys(entitySchema.shape).map((field) => [
      field,
      entity[field as keyof Entity],
    ]),
  );
}

export function persistGooglePlacesResults(
  store: Store,
  sourceId: string,
  results: Array<{ place: GooglePlace; matchedQueries: string[] }>,
  options: { enterpriseRatingSource?: string } = {},
) {
  if (!results.length) return null;
  const ctx = sourceContext(store, sourceId);
  const stored = store.ingest(
    ctx.source,
    results.map(({ place, matchedQueries }) => {
      const raw = googlePlacesRawItem({ ...place, matchedQueries }, ctx);
      return {
        raw,
        entity: entitySchema.parse(
          (raw.payload as { normalized: unknown }).normalized,
        ),
      };
    }),
  );
  if (options.enterpriseRatingSource) {
    const items = results.flatMap(({ place }) =>
      place.rating === undefined && place.userRatingCount === undefined
        ? []
        : [
            {
              placeId: place.id,
              rating: place.rating,
              reviewCount: place.userRatingCount,
              source: options.enterpriseRatingSource,
            },
          ],
    );
    if (items.length) applyGooglePlacesLlmRatings(store, { items });
  }
  return stored;
}

export function getGooglePlacesToolStatus() {
  const store = new Store();
  try {
    const discovered = store.db
      .prepare("SELECT COUNT(*) AS count FROM google_places_discovered_ids")
      .get() as { count: number };
    const enriched = store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM google_places_discovered_ids WHERE proFetchedAt IS NOT NULL OR enterpriseFetchedAt IS NOT NULL",
      )
      .get() as { count: number };
    return {
      ok: true,
      keyConfigured: Boolean(readSecrets().GOOGLE_PLACES_API_KEY),
      quota: googlePlacesQuotaStatus(store),
      discoveredPlaceIds: discovered.count,
      enrichedPlaceIds: enriched.count,
      defaultFlow: "ids_only -> pro",
      note: "Статус не вызывает Google API. Локальный счётчик не видит использование ключа вне Activity Checker.",
    };
  } finally {
    store.close();
  }
}

export async function executeGooglePlacesTierTool(
  mode: GooglePlacesSku,
  input: z.input<typeof googlePlacesTierToolSchema>,
) {
  const args = googlePlacesTierToolSchema.parse(input);
  if (mode === "enterprise" && args.execute && !args.confirmEnterprise)
    throw new Error(
      "Enterprise отключён по умолчанию. Для явного запуска передайте confirmEnterprise=true.",
    );
  const store = new Store();
  try {
    const ctx = sourceContext(store, args.sourceId);
    const queries = normalizeGooglePlacesQueries(args.queries);
    const location =
      args.location ||
      (ctx.scope.city ? `${ctx.scope.city}, Serbia` : "Serbia");
    const minRating = args.minRating ?? ctx.source.minRating;
    const plan = {
      mode,
      requestCount: queries.length,
      queries,
      location,
      minRating,
      resultsPerQuery: args.resultsPerQuery,
      maxItems: Math.min(args.maxItems, queries.length * args.resultsPerQuery),
      fieldMask: googlePlacesFieldMasks[mode],
      quotaBefore: googlePlacesQuotaStatus(store),
    };
    if (!args.execute) return { mode: "dry-run" as const, plan, results: [] };
    const result = await executeGooglePlacesBatch({
      store,
      apiKey: key(),
      sourceId: args.sourceId,
      queries,
      location,
      mode,
      minRating,
      resultsPerQuery: args.resultsPerQuery,
      maxItems: plan.maxItems,
    });
    const stored =
      mode === "ids_only"
        ? null
        : persistGooglePlacesResults(store, args.sourceId, result.results, {
            enterpriseRatingSource:
              mode === "enterprise"
                ? "Google Places API · Text Search Enterprise"
                : undefined,
          });
    return {
      mode: "executed" as const,
      plan,
      queries: result.queries,
      results: result.results.map(({ place, matchedQueries }) => ({
        ...compact(place),
        matchedQueries,
      })),
      stored,
      quotaAfter: googlePlacesQuotaStatus(store),
      persistence:
        mode === "ids_only"
          ? "Сохранены placeId, matchedQueries и служебные timestamps."
          : mode === "enterprise"
            ? "Place-карточки сохранены в SQLite вместе с API rating/reviewCount и временем проверки."
            : "Place-карточки сохранены в SQLite: название, Google Maps URI, адрес, гео и типы; API rating/reviewCount не записываются.",
    };
  } finally {
    store.close();
  }
}

export async function executeGooglePlacesDiscoveryTool(
  input: z.input<typeof googlePlacesDiscoveryToolSchema>,
) {
  const args = googlePlacesDiscoveryToolSchema.parse(input);
  const store = new Store();
  try {
    const ctx = sourceContext(store, args.sourceId);
    const queries = normalizeGooglePlacesQueries(args.queries);
    const location =
      args.location ||
      (ctx.scope.city ? `${ctx.scope.city}, Serbia` : "Serbia");
    const minRating = args.minRating ?? ctx.source.minRating;
    const plan = {
      flow: "ids_only -> pro" as const,
      queries,
      idsOnlyRequests: queries.length,
      proRequestsMaximum: queries.length,
      enterpriseRequests: 0,
      location,
      minRating,
      resultsPerQuery: args.resultsPerQuery,
      maxItems: Math.min(args.maxItems, queries.length * args.resultsPerQuery),
      minValidResultsPerQuery: args.minValidResultsPerQuery,
      idsOnlyFieldMask: googlePlacesFieldMasks.ids_only,
      proFieldMask: googlePlacesFieldMasks.pro,
      quotaBefore: googlePlacesQuotaStatus(store),
    };
    if (!args.execute) return { mode: "dry-run" as const, plan, results: [] };
    const result = await executeGooglePlacesDiscovery({
      store,
      apiKey: key(),
      sourceId: args.sourceId,
      queries,
      location,
      minRating,
      resultsPerQuery: args.resultsPerQuery,
      maxItems: plan.maxItems,
      minValidResultsPerQuery: args.minValidResultsPerQuery,
    });
    const stored = persistGooglePlacesResults(
      store,
      args.sourceId,
      result.results,
    );
    return {
      mode: "executed" as const,
      plan,
      idPass: result.idPass,
      proPass: result.proPass,
      productiveQueries: result.productiveQueries,
      results: result.results.map(({ place, matchedQueries }) => ({
        ...compact(place),
        matchedQueries,
      })),
      stored,
      quotaAfter: googlePlacesQuotaStatus(store),
      persistence:
        "Place-карточки сохранены в SQLite: название, Google Maps URI, адрес, гео и типы; API rating/reviewCount не записываются.",
    };
  } finally {
    store.close();
  }
}

export function applyGooglePlacesLlmRatings(
  store: Store,
  input: z.input<typeof googlePlacesLlmRatingsToolSchema>,
) {
  const args = googlePlacesLlmRatingsToolSchema.parse(input);
  const saved: Array<{
    placeId: string;
    entityId: string;
    rating: number | null;
    reviewCount: number | null;
  }> = [];
  const missing: string[] = [];
  for (const item of args.items) {
    const entityId = googlePlaceEntityId(store, item.placeId);
    if (!entityId) {
      missing.push(item.placeId);
      continue;
    }
    const current = store.entity(entityId);
    if (current.type !== "Place") {
      missing.push(item.placeId);
      continue;
    }
    const updated = store.editEntity(
      current.id,
      entitySchema.parse({
        ...entityInput(current),
        googleRating: item.rating ?? current.googleRating,
        googleReviewCount: item.reviewCount ?? current.googleReviewCount,
        googleRatingSource: item.source,
        googleRatingCheckedAt: item.checkedAt || new Date().toISOString(),
      }),
    );
    saved.push({
      placeId: item.placeId,
      entityId: updated.id,
      rating: updated.googleRating,
      reviewCount: updated.googleReviewCount,
    });
  }
  return {
    ok: missing.length === 0,
    saved,
    missing,
    apiRequests: 0,
    note: "Рейтинг сохранён как отдельное LLM-enrichment и не влияет на Google API quota.",
  };
}

export function storeGooglePlacesLlmRatings(
  input: z.input<typeof googlePlacesLlmRatingsToolSchema>,
) {
  const store = new Store();
  try {
    return applyGooglePlacesLlmRatings(store, input);
  } finally {
    store.close();
  }
}

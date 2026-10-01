import { randomUUID } from "node:crypto";
import type { Store } from "../../store.js";

export const googlePlacesSkus = ["ids_only", "pro", "enterprise"] as const;
export type GooglePlacesSku = (typeof googlePlacesSkus)[number];

export const googlePlacesSkuLimits: Record<GooglePlacesSku, number | null> = {
  ids_only: null,
  pro: 5_000,
  enterprise: 1_000,
};

export const googlePlacesSkuWeights: Record<GooglePlacesSku, number> = {
  ids_only: 0,
  pro: 1,
  enterprise: 5,
};

export function googleBillingMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Не удалось определить billing month.");
  return `${year}-${month}`;
}

export function googlePlacesQuotaStatus(store: Store, date = new Date()) {
  const billingMonth = googleBillingMonth(date);
  const rows = store.db
    .prepare(
      "SELECT sku,COUNT(*) AS used,COALESCE(SUM(weightUnits),0) AS weightedUnits FROM google_places_api_usage WHERE billingMonth=? GROUP BY sku",
    )
    .all(billingMonth) as Array<{
    sku: GooglePlacesSku;
    used: number;
    weightedUnits: number;
  }>;
  const bySku = Object.fromEntries(
    googlePlacesSkus.map((sku) => {
      const used = rows.find((row) => row.sku === sku)?.used || 0;
      const limit = googlePlacesSkuLimits[sku];
      return [
        sku,
        {
          used,
          limit,
          remaining: limit === null ? null : Math.max(0, limit - used),
          weight: googlePlacesSkuWeights[sku],
          weightedUnits: used * googlePlacesSkuWeights[sku],
        },
      ];
    }),
  ) as Record<
    GooglePlacesSku,
    {
      used: number;
      limit: number | null;
      remaining: number | null;
      weight: number;
      weightedUnits: number;
    }
  >;
  return {
    billingMonth,
    resetRule: "Первое число месяца, 00:00 America/Los_Angeles",
    bySku,
    proEquivalentUnits:
      bySku.pro.weightedUnits + bySku.enterprise.weightedUnits,
    note: "Google считает free usage отдельно по SKU. Вес — локальная сравнительная метрика; внешний трафик вне Activity Checker здесь не виден.",
  };
}

export function reserveGooglePlacesRequest(
  store: Store,
  sku: GooglePlacesSku,
  query: string,
  sourceId?: string,
  date = new Date(),
) {
  return store.transaction(() => {
    const status = googlePlacesQuotaStatus(store, date);
    const current = status.bySku[sku];
    if (current.limit !== null && current.used >= current.limit)
      throw new Error(
        `Локальный лимит Google Places ${sku} исчерпан: ${current.used}/${current.limit} за ${status.billingMonth}. Запрос заблокирован до сброса квоты.`,
      );
    const id = randomUUID();
    store.db
      .prepare(
        "INSERT INTO google_places_api_usage(id,billingMonth,sku,weightUnits,query,sourceId,requestedAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        status.billingMonth,
        sku,
        googlePlacesSkuWeights[sku],
        query,
        sourceId || null,
        date.toISOString(),
      );
    return { id, quota: googlePlacesQuotaStatus(store, date) };
  });
}

export function finishGooglePlacesRequest(
  store: Store,
  id: string,
  outcome: "success" | "error",
  resultCount: number,
  error?: string,
) {
  store.db
    .prepare(
      "UPDATE google_places_api_usage SET completedAt=?,outcome=?,resultCount=?,error=? WHERE id=?",
    )
    .run(
      new Date().toISOString(),
      outcome,
      resultCount,
      error?.slice(0, 800) || null,
      id,
    );
}

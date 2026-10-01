import { z } from "zod";
import type { Store } from "../../store.js";
import {
  finishGooglePlacesRequest,
  googlePlacesQuotaStatus,
  reserveGooglePlacesRequest,
  type GooglePlacesSku,
} from "./quota.js";

const endpoint = "https://places.googleapis.com/v1/places:searchText";

const displayNameSchema = z
  .object({ text: z.string().default(""), languageCode: z.string().optional() })
  .passthrough();
const locationSchema = z
  .object({ latitude: z.number(), longitude: z.number() })
  .passthrough();

export const googlePlaceSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().optional(),
    displayName: displayNameSchema.optional(),
    formattedAddress: z.string().optional(),
    shortFormattedAddress: z.string().optional(),
    location: locationSchema.optional(),
    googleMapsUri: z.string().optional(),
    googleMapsLinks: z.unknown().optional(),
    primaryType: z.string().optional(),
    primaryTypeDisplayName: displayNameSchema.optional(),
    types: z.array(z.string()).optional(),
    businessStatus: z.string().optional(),
    rating: z.number().optional(),
    userRatingCount: z.number().int().min(0).optional(),
    websiteUri: z.string().optional(),
    internationalPhoneNumber: z.string().optional(),
    nationalPhoneNumber: z.string().optional(),
    priceLevel: z.string().optional(),
    regularOpeningHours: z.unknown().optional(),
    currentOpeningHours: z.unknown().optional(),
  })
  .passthrough();
export type GooglePlace = z.output<typeof googlePlaceSchema>;

const responseSchema = z
  .object({
    places: z.array(googlePlaceSchema).default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

const idsOnlyFields = ["places.id", "places.name", "nextPageToken"];
const proFields = [
  "places.id",
  "places.name",
  "places.businessStatus",
  "places.displayName",
  "places.formattedAddress",
  "places.googleMapsUri",
  "places.location",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.shortFormattedAddress",
  "places.types",
  "nextPageToken",
];
const enterpriseFields = [
  ...proFields,
  "places.currentOpeningHours",
  "places.currentSecondaryOpeningHours",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.priceLevel",
  "places.priceRange",
  "places.rating",
  "places.regularOpeningHours",
  "places.regularSecondaryOpeningHours",
  "places.transitStation",
  "places.userRatingCount",
  "places.websiteUri",
];

export const googlePlacesFieldMasks: Record<GooglePlacesSku, string> = {
  ids_only: idsOnlyFields.join(","),
  pro: [...new Set(proFields)].join(","),
  enterprise: [...new Set(enterpriseFields)].join(","),
};

export const googlePlacesTextSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    location: z.string().trim().min(1).max(200).default("Belgrade, Serbia"),
    mode: z.enum(["ids_only", "pro", "enterprise"]),
    minRating: z.number().min(0).max(5).multipleOf(0.5).default(4),
    pageSize: z.number().int().min(1).max(20).default(10),
    languageCode: z.string().trim().min(2).max(10).default("en"),
    regionCode: z.string().trim().length(2).default("RS"),
    apiKey: z.string().trim().min(16),
    sourceId: z.string().min(1).max(200).optional(),
  })
  .strict();

function textQuery(query: string, location: string) {
  const normalized = query.toLocaleLowerCase();
  if (
    /\b(?:belgrade|beograd|serbia|srbija|белград|серби[яи])\b/iu.test(
      normalized,
    )
  )
    return query;
  return `${query} in ${location}`;
}

async function responseJson(response: Response) {
  const body = await response.text();
  if (body.length > 20 * 1024 * 1024)
    throw new Error("Google Places вернул больше 20 МБ.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Google Places вернул невалидный JSON.");
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { message?: unknown } }).error?.message
        : undefined;
    throw new Error(
      `Google Places API ответил HTTP ${response.status}${typeof message === "string" ? ` · ${message}` : ""}`,
    );
  }
  return parsed;
}

export async function searchGooglePlacesText(
  input: z.input<typeof googlePlacesTextSearchSchema>,
  store: Store,
) {
  const args = googlePlacesTextSearchSchema.parse(input);
  const sentQuery = textQuery(args.query, args.location);
  const reservation = reserveGooglePlacesRequest(
    store,
    args.mode,
    sentQuery,
    args.sourceId,
  );
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": args.apiKey,
        "X-Goog-FieldMask": googlePlacesFieldMasks[args.mode],
      },
      body: JSON.stringify({
        textQuery: sentQuery,
        languageCode: args.languageCode,
        regionCode: args.regionCode.toUpperCase(),
        minRating: args.minRating,
        pageSize: args.pageSize,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = responseSchema.parse(await responseJson(response));
    finishGooglePlacesRequest(
      store,
      reservation.id,
      "success",
      parsed.places.length,
    );
    return {
      query: args.query,
      sentQuery,
      mode: args.mode,
      fieldMask: googlePlacesFieldMasks[args.mode],
      places: parsed.places,
      nextPageToken: parsed.nextPageToken || null,
      quota: googlePlacesQuotaStatus(store),
    };
  } catch (error) {
    finishGooglePlacesRequest(
      store,
      reservation.id,
      "error",
      0,
      error instanceof Error ? error.message : "Неизвестная ошибка",
    );
    throw error;
  }
}

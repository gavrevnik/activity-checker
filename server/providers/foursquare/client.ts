import { z } from "zod";
import { reserveFoursquareRequest } from "./quota.js";

export const foursquareApiVersion = "2025-06-17";
const endpoint = "https://places-api.foursquare.com/places/search";

const categorySchema = z
  .object({
    fsq_category_id: z.string().optional(),
    name: z.string().default(""),
    short_name: z.string().optional(),
  })
  .passthrough();
const locationSchema = z
  .object({
    address: z.string().optional(),
    formatted_address: z.string().optional(),
    locality: z.string().optional(),
    region: z.string().optional(),
    postcode: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();
export const foursquarePlaceSchema = z
  .object({
    fsq_place_id: z.string().min(1),
    name: z.string().trim().min(1),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    categories: z.array(categorySchema).default([]),
    location: locationSchema.optional(),
    address: z.string().optional(),
    locality: z.string().optional(),
    region: z.string().optional(),
    postcode: z.string().optional(),
    country: z.string().optional(),
    description: z.string().optional(),
    tel: z.string().optional(),
    website: z.string().optional(),
    rating: z.number().optional(),
    price: z.number().int().min(1).max(4).optional(),
    hours: z.unknown().optional(),
  })
  .passthrough();
export type FoursquarePlace = z.output<typeof foursquarePlaceSchema>;

const responseSchema = z.object({
  results: z.array(foursquarePlaceSchema),
});

export const foursquareSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    near: z.string().trim().min(1).max(200).default("Belgrade, Serbia"),
    limit: z.number().int().min(1).max(50).default(10),
    apiKey: z.string().trim().min(16),
  })
  .strict();

export async function searchFoursquarePlaces(
  input: z.input<typeof foursquareSearchSchema>,
) {
  const args = foursquareSearchSchema.parse(input);
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    query: args.query,
    near: args.near,
    limit: String(args.limit),
    sort: "RELEVANCE",
  }).toString();
  const quota = reserveFoursquareRequest();
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${args.apiKey}`,
      "X-Places-Api-Version": foursquareApiVersion,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      `Foursquare Places API ответил HTTP ${response.status}${response.status === 429 ? " · исчерпан внешний rate limit" : ""}.`,
    );
  if (body.length > 10 * 1024 * 1024)
    throw new Error("Foursquare вернул больше 10 МБ.");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Foursquare вернул невалидный JSON.");
  }
  const parsed = responseSchema.parse(json);
  return { query: args.query, places: parsed.results, quota };
}

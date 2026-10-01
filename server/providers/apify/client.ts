import { z } from "zod";

export const apifyProviderIds = [
  "instagram",
  "facebook-apify",
  "google-places",
] as const;
export type ApifyProviderId = (typeof apifyProviderIds)[number];

export const apifyConfigs = {
  instagram: {
    actor: "apify~instagram-search-scraper",
    label: "Instagram Search",
    unit: "результат",
    pricePerResult: 0.0027,
    defaultResultsPerQuery: 10,
    defaultMaxItems: 100,
  },
  "facebook-apify": {
    actor: "apify~facebook-events-scraper",
    label: "Facebook Events",
    unit: "событие",
    pricePerResult: 0.013,
    defaultResultsPerQuery: 5,
    defaultMaxItems: 20,
  },
  "google-places": {
    actor: "compass~crawler-google-places",
    label: "Google Maps",
    unit: "место",
    pricePerResult: 0.004,
    defaultResultsPerQuery: 5,
    defaultMaxItems: 30,
  },
} as const;

const argsSchema = z.object({
  providerId: z.enum(apifyProviderIds),
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  token: z.string().trim().min(10),
  resultsPerQuery: z.number().int().min(1).max(100),
  maxItems: z.number().int().min(1).max(500),
  testMode: z.boolean().default(false),
});

export interface ApifyBatchResult {
  items: unknown[];
  actor: string;
  queryCount: number;
  resultsPerQuery: number;
  maxItems: number;
  maxChargeUsd: number;
}

export function normalizeQueries(values: string[]) {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 30);
}

export function queriesFromText(value: string) {
  return normalizeQueries(value.split(/[\n\r]+|\s*;\s*/));
}

export function apifyCost(providerId: ApifyProviderId, maxItems: number) {
  const raw = apifyConfigs[providerId].pricePerResult * maxItems;
  return Math.ceil(raw * 100) / 100;
}

export function buildApifyInput(
  providerId: ApifyProviderId,
  queries: string[],
  resultsPerQuery: number,
) {
  if (providerId === "instagram")
    return {
      search: queries.join(", "),
      searchType: "user",
      searchLimit: resultsPerQuery,
    };
  if (providerId === "facebook-apify")
    return {
      searchQueries: queries,
      startUrls: [],
      maxEvents: resultsPerQuery,
    };
  return {
    searchStringsArray: queries,
    locationQuery: "Belgrade, Serbia",
    maxCrawledPlacesPerSearch: resultsPerQuery,
    language: "en",
    maxImages: 0,
    maxReviews: 0,
    scrapeDirectories: false,
  };
}

export function compactApifyItem(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const item = input as Record<string, unknown>;
  const keys = [
    "searchTerm",
    "id",
    "eventId",
    "placeId",
    "username",
    "fullName",
    "name",
    "title",
    "biography",
    "description",
    "url",
    "eventUrl",
    "externalUrl",
    "followersCount",
    "startDate",
    "utcStartDate",
    "endDate",
    "utcEndDate",
    "address",
    "city",
    "countryCode",
    "categories",
    "website",
    "phone",
    "totalScore",
    "reviewsCount",
    "location",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => item[key] !== undefined)
      .map((key) => [key, item[key]]),
  );
}

async function jsonResponse(response: Response) {
  const body = await response.text();
  if (body.length > 20 * 1024 * 1024)
    throw new Error("Apify вернул больше 20 МБ. Уменьшите лимит результатов.");
  if (!response.ok)
    throw new Error(
      `Apify ответил HTTP ${response.status}${response.status === 402 ? " · проверьте баланс" : ""}${response.status === 429 ? " · лимит запросов" : ""}.`,
    );
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Apify вернул невалидный JSON.");
  }
}

export async function checkApifyToken(token: string) {
  const response = await fetch("https://api.apify.com/v2/users/me", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const value = await jsonResponse(response);
  const parsed = z
    .object({
      data: z.object({ username: z.string().optional() }).passthrough(),
    })
    .passthrough()
    .parse(value);
  return parsed.data.username || "аккаунт доступен";
}

export async function executeApifyBatch(
  input: z.input<typeof argsSchema>,
): Promise<ApifyBatchResult> {
  const args = argsSchema.parse(input);
  const queries = normalizeQueries(args.queries);
  const config = apifyConfigs[args.providerId];
  const resultsPerQuery = args.testMode
    ? Math.min(args.resultsPerQuery, 2)
    : args.resultsPerQuery;
  const maxItems = args.testMode ? Math.min(args.maxItems, 2) : args.maxItems;
  const maxChargeUsd = apifyCost(args.providerId, maxItems);
  const params = new URLSearchParams({
    timeout: "300",
    maxItems: String(maxItems),
    maxTotalChargeUsd: maxChargeUsd.toFixed(2),
  });
  const response = await fetch(
    `https://api.apify.com/v2/actors/${config.actor}/run-sync-get-dataset-items?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildApifyInput(args.providerId, queries, resultsPerQuery),
      ),
      signal: AbortSignal.timeout(330000),
    },
  );
  const value = await jsonResponse(response);
  if (!Array.isArray(value))
    throw new Error("Apify dataset имеет неожиданный формат.");
  return {
    items: value.slice(0, maxItems),
    actor: config.actor,
    queryCount: queries.length,
    resultsPerQuery,
    maxItems,
    maxChargeUsd,
  };
}

import { createHash } from "node:crypto";
import {
  entitySchema,
  type NormalizedEntity,
  type SyncOptions,
} from "../../../shared/model.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
import {
  apifyConfigs,
  apifyCost,
  checkApifyToken,
  executeApifyBatch,
  queriesFromText,
  type ApifyProviderId,
} from "./client.js";

const apifyIds = new Set<ApifyProviderId>([
  "instagram",
  "facebook-apify",
  "google-places",
]);

function value(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
    if (typeof candidate === "number") return String(candidate);
  }
  return "";
}
function numeric(record: Record<string, unknown>, ...keys: string[]) {
  const raw = value(record, ...keys);
  if (!raw) return null;
  const candidate = Number(raw);
  return Number.isFinite(candidate) ? candidate : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function absoluteUrl(input: unknown) {
  if (typeof input !== "string" || !input.trim()) return "";
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
function countryFromWebsite(website: string, fallback: string) {
  try {
    const host = new URL(website).hostname.toLowerCase();
    if (host.endsWith(".rs")) return "RS";
    if (host.endsWith(".ro")) return "RO";
    if (host.endsWith(".me")) return "ME";
    if (host.endsWith(".hr")) return "HR";
    if (host.endsWith(".ba")) return "BA";
  } catch {}
  return fallback;
}
function instagramCity(data: Record<string, unknown>) {
  const haystack = [
    value(data, "fullName", "name"),
    value(data, "biography", "bio"),
    value(data, "externalUrl"),
  ].join(" ");
  return /\b(?:belgrade|beograd|zemun|novi beograd|bežanij\w*)\b/iu.test(
    haystack,
  )
    ? "Belgrade"
    : "";
}
function stringList(input: unknown) {
  return Array.isArray(input)
    ? input
        .map((item) =>
          typeof item === "string"
            ? item
            : value(record(item), "title", "name", "label", "url"),
        )
        .filter(Boolean)
    : [];
}
function projectCategory(values: string[], fallback = "Другое") {
  const text = values.join(" ").toLowerCase();
  if (/music|concert|party|nightclub|dance/.test(text)) return "Музыка";
  if (/art|museum|gallery|theat|performance|comedy|exhibition/.test(text))
    return "Искусство";
  if (/sport|fitness|gym|recreation|stadium|court|yoga/.test(text))
    return "Спорт";
  if (/food|restaurant|cafe|coffee|bar|wine|brew/.test(text))
    return "Еда и напитки";
  if (
    /school|education|class|workshop|conference|technology|business/.test(text)
  )
    return "Обучение";
  if (/game|gaming|escape|bowling/.test(text)) return "Игры";
  if (/movie|cinema|film/.test(text)) return "Кино";
  if (/meetup|community|social|network/.test(text)) return "Общение";
  return fallback;
}
function stableId(providerId: ApifyProviderId, item: unknown) {
  const data = record(item);
  const known = value(
    data,
    "id",
    "eventId",
    "placeId",
    "username",
    "url",
    "eventUrl",
  );
  return (
    known || createHash("sha256").update(JSON.stringify(item)).digest("hex")
  );
}
function unwrapInstagram(item: unknown) {
  const outer = record(item);
  return Object.keys(record(outer.user)).length ? record(outer.user) : outer;
}
function instagramEntity(
  item: unknown,
  ctx: ProviderContext,
): NormalizedEntity {
  const data = unwrapInstagram(item);
  const username = value(data, "username", "userName");
  const title =
    value(data, "fullName", "name") || (username ? `@${username}` : "");
  if (!title) throw new Error("Instagram: нет имени профиля.");
  const url =
    absoluteUrl(data.url) ||
    (username
      ? `https://www.instagram.com/${encodeURIComponent(username)}/`
      : "");
  const followers = numeric(data, "followersCount", "followers");
  const website = absoluteUrl(data.externalUrl);
  const description = [
    value(data, "biography", "bio"),
    followers !== null ? `Подписчики: ${followers}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return entitySchema.parse({
    type: "Community",
    title,
    description,
    country: countryFromWebsite(website, ctx.scope.country),
    city: instagramCity(data),
    category: "Общение",
    rawCategory: "instagram profile",
    tags: ["instagram"],
    url,
    website,
    imageUrl:
      absoluteUrl(data.profilePicUrlHD) || absoluteUrl(data.profilePicUrl),
    memberCount: followers,
    externalId: value(data, "id") || username,
    knownIds: username ? { instagram: username } : {},
  });
}
function facebookEntity(item: unknown, ctx: ProviderContext): NormalizedEntity {
  const data = record(item);
  const location = record(data.location);
  const place = record(data.place);
  const title = value(data, "name", "title");
  if (!title) throw new Error("Facebook Events: нет названия.");
  const startAt = value(data, "utcStartDate", "startDate", "startTime");
  const endAt = value(data, "utcEndDate", "endDate", "endTime");
  const organizers = stringList(data.organizers);
  const categories = stringList(data.categories);
  const image = record(data.coverPhoto);
  return entitySchema.parse({
    type: "Event",
    title,
    description: [
      value(data, "description"),
      organizers.length ? `Организаторы: ${organizers.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    country: ctx.scope.country,
    city:
      value(location, "city") || value(place, "city") || ctx.scope.city || "",
    category: projectCategory(categories),
    rawCategory: categories.join(", "),
    tags: ["facebook", ...categories].slice(0, 50),
    startAt,
    endAt,
    venue: value(location, "name") || value(place, "name"),
    address: value(location, "address") || value(place, "address"),
    latitude:
      numeric(location, "latitude", "lat") ?? numeric(place, "latitude", "lat"),
    longitude:
      numeric(location, "longitude", "lng", "lon") ??
      numeric(place, "longitude", "lng", "lon"),
    url: absoluteUrl(data.url) || absoluteUrl(data.eventUrl),
    website: absoluteUrl(data.ticketUrl) || absoluteUrl(data.ticketsUrl),
    imageUrl: absoluteUrl(data.imageUrl) || absoluteUrl(image.url),
    price: value(data, "price"),
    externalId: value(data, "id", "eventId"),
    knownIds: value(data, "id", "eventId")
      ? { facebook: value(data, "id", "eventId") }
      : {},
  });
}
function googlePlaceEntity(
  item: unknown,
  ctx: ProviderContext,
): NormalizedEntity {
  const data = record(item);
  const location = record(data.location);
  const title = value(data, "title", "name");
  if (!title) throw new Error("Google Maps: нет названия места.");
  const categories = stringList(data.categories);
  const rating = numeric(data, "totalScore", "rating");
  const reviews = numeric(data, "reviewsCount", "numberOfReviews");
  const hours = record(data.openingHours);
  return entitySchema.parse({
    type: "Place",
    title,
    description: [
      value(data, "description"),
      rating !== null
        ? `Рейтинг: ${rating}${reviews !== null ? ` (${reviews} отзывов)` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    country: value(data, "countryCode").slice(0, 2) || ctx.scope.country,
    city: value(data, "city") || ctx.scope.city || "",
    category: projectCategory(categories),
    rawCategory: categories.join(", "),
    tags: ["google-maps", ...categories].slice(0, 50),
    address: value(data, "address", "street"),
    latitude: numeric(location, "lat", "latitude") ?? numeric(data, "latitude"),
    longitude:
      numeric(location, "lng", "longitude") ?? numeric(data, "longitude"),
    url: absoluteUrl(data.url),
    website: absoluteUrl(data.website),
    imageUrl: absoluteUrl(data.imageUrl),
    phone: value(data, "phone", "phoneUnformatted"),
    openingHours:
      stringList(hours.days).join("\n") ||
      (Object.keys(hours).length ? JSON.stringify(hours) : ""),
    externalId: value(data, "placeId", "id"),
    knownIds: value(data, "placeId")
      ? { google_place: value(data, "placeId") }
      : {},
  });
}

function entityFor(
  providerId: ApifyProviderId,
  item: unknown,
  ctx: ProviderContext,
) {
  if (providerId === "instagram") return instagramEntity(item, ctx);
  if (providerId === "facebook-apify") return facebookEntity(item, ctx);
  return googlePlaceEntity(item, ctx);
}

function rawFor(
  providerId: ApifyProviderId,
  item: unknown,
  ctx: ProviderContext,
): RawItem {
  const normalized = entityFor(providerId, item, ctx);
  const externalId = normalized.externalId || stableId(providerId, item);
  return {
    externalId,
    url: normalized.url || normalized.website,
    rawText: [normalized.title, normalized.description, normalized.address]
      .filter(Boolean)
      .join("\n"),
    payload: { original: item, normalized },
    publishedAt: normalized.startAt || undefined,
  };
}

function settings(
  providerId: ApifyProviderId,
  ctx: ProviderContext,
  options: SyncOptions,
) {
  const config = apifyConfigs[providerId];
  const queries = queriesFromText(ctx.source.keyword);
  if (!queries.length)
    throw new Error(
      "Добавьте хотя бы одну поисковую гипотезу в настройках источника.",
    );
  const resultsPerQuery =
    options.resultsPerQuery || config.defaultResultsPerQuery;
  const possible = Math.min(500, queries.length * resultsPerQuery);
  const maxItems = Math.min(
    options.maxItems || config.defaultMaxItems,
    possible,
  );
  return { config, queries, resultsPerQuery, maxItems };
}

function provider(
  providerId: ApifyProviderId,
  info: {
    name: string;
    group: string;
    entity: "Event" | "Place" | "Community";
    description: string;
    actorUrl: string;
    limitations: string;
  },
) {
  return defineProvider(
    {
      id: providerId,
      name: info.name,
      group: info.group,
      providerType: "Apify Actor",
      supportedEntityTypes: [info.entity],
      supportedScopes: ["belgrade"],
      implemented: true,
      mode: "discovery",
      configFields: ["keyword"],
      credentials: [{ key: "APIFY_TOKEN", label: "Personal API token" }],
      registration: { service: "Apify", url: "https://console.apify.com/" },
      manualSyncOnly: true,
      requiresSyncConfirmation: true,
      modelCallable: true,
      mcpServer: "Activity Checker Apify",
      mcpTools: [
        {
          name: "apify_status",
          description:
            "Бесплатно проверяет APIFY_TOKEN без запуска платного Actor.",
        },
        {
          name:
            providerId === "instagram"
              ? "apify_instagram_search"
              : providerId === "facebook-apify"
                ? "apify_facebook_events_search"
                : "apify_google_places_search",
          description:
            providerId === "instagram"
              ? "Ищет публичные Instagram-профили по пакету ключевых гипотез."
              : providerId === "facebook-apify"
                ? "Ищет публичные Facebook Events по пакету ключевых гипотез."
                : "Ищет места Google Maps по пакету ключевых гипотез.",
        },
      ],
      description: `MCP · ${info.description}`,
      docs: [
        { label: "Actor", url: info.actorUrl },
        {
          label: "API token",
          url: "https://console.apify.com/account/integrations",
        },
      ],
      steps: [
        "Добавьте поисковые гипотезы по одной на строку (не более 30).",
        "Нажмите проверку, чтобы бесплатно проверить токен, затем Sync.",
        "В модальном окне проверьте один batch-run, лимит результатов и максимальную стоимость.",
      ],
      limitations: info.limitations,
    },
    {
      async testConnection(ctx) {
        const username = await checkApifyToken(ctx.secrets.APIFY_TOKEN || "");
        return `Apify token действителен (${username}). Actor не запускался, платные результаты не запрашивались.`;
      },
      async planSync(ctx, options) {
        const selected = settings(providerId, ctx, options);
        const maxChargeUsd = apifyCost(providerId, selected.maxItems);
        return {
          sourceId: ctx.source.id,
          providerId,
          title: `Подтвердите запуск ${selected.config.label}`,
          summary: `${selected.queries.length} поисковых гипотез будут объединены в один Actor run.`,
          requiresConfirmation: true,
          expectedRequests: 1,
          minimumRequests: 1,
          maximumRequests: 1,
          resultsPerQuery: selected.resultsPerQuery,
          parameters: [
            { label: "Actor", value: selected.config.actor.replace("~", "/") },
            { label: "Гипотезы", value: String(selected.queries.length) },
            { label: "На гипотезу", value: `до ${selected.resultsPerQuery}` },
            {
              label: "Общий hard cap",
              value: `${selected.maxItems} результатов`,
            },
            { label: "Actor runs", value: "1" },
          ],
          warnings: [
            `Оплата зависит от фактической выдачи; верхняя оценка по рабочей ставке: $${maxChargeUsd.toFixed(2)}.`,
            providerId === "facebook-apify"
              ? "Facebook Events заметно дороже других источников — уменьшайте число гипотез и общий лимит."
              : "Перед запуском сопоставьте лимит с оставшимся бюджетом Apify.",
          ],
          paid: { maxItems: selected.maxItems, maxChargeUsd },
        };
      },
      async sync(ctx, options = { confirmed: false }) {
        const selected = settings(providerId, ctx, options);
        const batch = await executeApifyBatch({
          providerId,
          queries: selected.queries,
          token: ctx.secrets.APIFY_TOKEN || "",
          resultsPerQuery: selected.resultsPerQuery,
          maxItems: selected.maxItems,
          testMode: false,
        });
        const items: RawItem[] = [];
        const warnings: string[] = [];
        for (const item of batch.items) {
          try {
            items.push(rawFor(providerId, item, ctx));
          } catch (error) {
            warnings.push(
              `${info.name}: запись пропущена — ${error instanceof Error ? error.message : "неверный формат"}`,
            );
          }
        }
        return {
          items,
          warnings: [
            `Выполнен один Actor run: ${batch.queryCount} гипотез, hard cap ${batch.maxItems}, верхняя оценка $${batch.maxChargeUsd.toFixed(2)}.`,
            ...warnings,
          ],
        };
      },
      normalize(item) {
        const payload = record(item.payload);
        return entitySchema.parse(payload.normalized);
      },
    },
  );
}

export const instagram = provider("instagram", {
  name: "Instagram Search · Apify",
  group: "MCP",
  entity: "Community",
  description: "Batch-поиск публичных профилей сообществ и организаторов.",
  actorUrl: "https://apify.com/apify/instagram-search-scraper",
  limitations:
    "Платный Actor: ориентир $0.0027 за результат. Один запуск принимает до 30 гипотез; выдача зависит от публичной доступности Instagram.",
});
export const facebook = provider("facebook-apify", {
  name: "Facebook Events · Apify",
  group: "MCP",
  entity: "Event",
  description: "Batch-поиск публичных Facebook Events по гипотезам.",
  actorUrl: "https://apify.com/apify/facebook-events-scraper",
  limitations:
    "Самый дорогой из подключённых Actor: ориентир $0.013 за событие. Всегда проверяйте общий hard cap перед запуском.",
});
export const googlePlaces = provider("google-places", {
  name: "Google Maps Places · Apify",
  group: "MCP",
  entity: "Place",
  description:
    "Batch-discovery мест через Google Maps без отдельного Google API key.",
  actorUrl: "https://apify.com/compass/crawler-google-places",
  limitations:
    "Платный Actor: ориентир $0.004 за место. Обогащения изображениями и отзывами отключены для экономии.",
});

export const apifyProviders = [instagram, facebook, googlePlaces];

export function isApifyProviderId(value: string): value is ApifyProviderId {
  return apifyIds.has(value as ApifyProviderId);
}

export { rawFor as apifyRawItem };

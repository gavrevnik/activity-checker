import { entitySchema, type NormalizedEntity } from "../../../shared/model.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
import { normalizeGooglePlacesQueries } from "./discovery.js";
import { searchGooglePlacesText, type GooglePlace } from "./client.js";
import { googlePlacesQuotaStatus } from "./quota.js";

function absoluteUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function projectCategory(types: string[]) {
  const value = types.join(" ").toLowerCase();
  if (/sport|fitness|gym|stadium|court|hiking/.test(value)) return "Спорт";
  if (/park|tour|natural|landmark/.test(value)) return "Прогулки";
  if (/art|museum|gallery|theat|music|concert/.test(value)) return "Искусство";
  if (/food|restaurant|cafe|coffee|bar|wine|brew/.test(value))
    return "Еда и напитки";
  if (/school|education|university|class|library/.test(value))
    return "Обучение";
  if (/game|gaming|bowling/.test(value)) return "Игры";
  return "Другое";
}

function openingHours(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const descriptions = (value as { weekdayDescriptions?: unknown })
    .weekdayDescriptions;
  return Array.isArray(descriptions)
    ? descriptions
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : "";
}

export function googlePlacesEntity(
  place: GooglePlace,
  ctx: ProviderContext,
): NormalizedEntity {
  const title = place.displayName?.text.trim() || "";
  if (!title)
    throw new Error("Google Places: Pro/Enterprise result has no displayName.");
  if (!place.location)
    throw new Error("Google Places: result has no location.");
  const types = place.types || [];
  return entitySchema.parse({
    type: "Place",
    title,
    description: place.primaryTypeDisplayName?.text || "",
    country: ctx.scope.country,
    city: ctx.scope.city || "",
    category: projectCategory(types),
    rawCategory: [place.primaryType, ...types].filter(Boolean).join(", "),
    tags: ["google-places-new", ...types].slice(0, 50),
    address: place.formattedAddress || place.shortFormattedAddress || "",
    latitude: place.location.latitude,
    longitude: place.location.longitude,
    url:
      absoluteUrl(place.googleMapsUri) ||
      `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(place.id)}`,
    website: absoluteUrl(place.websiteUri),
    phone: place.internationalPhoneNumber || place.nationalPhoneNumber || "",
    price: place.priceLevel || "",
    openingHours:
      openingHours(place.regularOpeningHours) ||
      openingHours(place.currentOpeningHours),
    externalId: place.id,
    knownIds: { google_place: place.id },
  });
}

export function googlePlacesRawItem(
  place: GooglePlace & { matchedQueries?: string[] },
  ctx: ProviderContext,
): RawItem {
  const normalized = googlePlacesEntity(place, ctx);
  const storedPlace = {
    id: place.id,
    name: place.name,
    displayName: place.displayName,
    formattedAddress: place.formattedAddress,
    shortFormattedAddress: place.shortFormattedAddress,
    location: place.location,
    googleMapsUri: place.googleMapsUri,
    primaryType: place.primaryType,
    primaryTypeDisplayName: place.primaryTypeDisplayName,
    types: place.types,
    businessStatus: place.businessStatus,
    matchedQueries: place.matchedQueries || [],
  };
  return {
    externalId: place.id,
    url: normalized.url,
    rawText: [normalized.title, normalized.address, normalized.description]
      .filter(Boolean)
      .join("\n"),
    payload: { original: storedPlace, normalized },
  };
}

function contextStore(ctx: ProviderContext) {
  if (!ctx.store)
    throw new Error(
      "Google Places requires an Activity Checker Store context.",
    );
  return ctx.store;
}

function location(ctx: ProviderContext) {
  return ctx.scope.city ? `${ctx.scope.city}, Serbia` : "Serbia";
}

export const googlePlacesApi = defineProvider(
  {
    id: "google-places-api",
    name: "Google Places API (New)",
    group: "MCP",
    providerType: "Official Places API MCP",
    supportedEntityTypes: ["Place"],
    supportedScopes: ["belgrade", "serbia"],
    implemented: true,
    mode: "discovery",
    configFields: ["scope", "keyword", "minRating"],
    description:
      "MCP · Официальный Text Search: бесплатный IDs-only discovery и выборочный Pro/Enterprise.",
    credentials: [
      { key: "GOOGLE_PLACES_API_KEY", label: "Google Maps API key" },
    ],
    registration: {
      service: "Google Maps Platform",
      url: "https://console.cloud.google.com/google/maps-apis/credentials",
    },
    manualSyncOnly: true,
    requiresSyncConfirmation: true,
    modelCallable: true,
    mcpServer: "Activity Checker Google Places",
    mcpTools: [
      {
        name: "google_places_status",
        description:
          "Показывает локальные месячные счётчики IDs/Pro/Enterprise без API-запроса.",
      },
      {
        name: "google_places_discovery_batch",
        description:
          "Дефолтный flow: IDs-only → только продуктивные гипотезы в Pro.",
      },
      {
        name: "google_places_text_search_ids",
        description:
          "Unlimited IDs-only Text Search для проверки гипотез и новых placeId.",
      },
      {
        name: "google_places_text_search_pro",
        description:
          "Text Search Pro со стабильными полями карточки: имя, адрес, гео, типы и Google Maps URI.",
      },
      {
        name: "google_places_text_search_enterprise",
        description:
          "Явный Enterprise-поиск с рейтингом и числом отзывов; не используется по умолчанию.",
      },
      {
        name: "google_places_store_llm_ratings",
        description:
          "Сохраняет проверенные LLM рейтинг и число отзывов в уже найденные Place-карточки без вызова Google API.",
      },
    ],
    docs: [
      {
        label: "Text Search (New)",
        url: "https://developers.google.com/maps/documentation/places/web-service/text-search",
      },
      {
        label: "Pricing",
        url: "https://developers.google.com/maps/billing-and-pricing/pricing",
      },
    ],
    steps: [
      "Добавьте до 30 поисковых гипотез; минимальный рейтинг по умолчанию 4.0.",
      "Сначала запускайте IDs-only и исключайте уже известные placeId.",
      "Для продуктивных гипотез используйте Pro; Enterprise — только по явному запросу.",
    ],
    limitations:
      "Локальный счётчик блокирует 5 001-й Pro и 1 001-й Enterprise-вызов за billing month. Он не видит запросы, сделанные вне Activity Checker; настройте Cloud quota как второй уровень защиты.",
  },
  {
    async testConnection(ctx) {
      const result = await searchGooglePlacesText(
        {
          query: "coffee",
          location: location(ctx),
          mode: "ids_only",
          minRating: ctx.source.minRating,
          pageSize: 1,
          apiKey: ctx.secrets.GOOGLE_PLACES_API_KEY || "",
          sourceId: ctx.source.id,
        },
        contextStore(ctx),
      );
      return `Google Places API отвечает через IDs-only. Найдено: ${result.places.length}; платная Pro/Enterprise квота не использована.`;
    },
    async planSync(ctx, options) {
      const queries = normalizeGooglePlacesQueries(
        ctx.source.keyword.split(/[\n\r]+|\s*;\s*/),
      );
      if (!queries.length)
        throw new Error("Добавьте хотя бы одну поисковую гипотезу.");
      const quota = googlePlacesQuotaStatus(contextStore(ctx));
      return {
        sourceId: ctx.source.id,
        providerId: "google-places-api",
        title: "Google Places · IDs-only → Pro",
        summary: `${queries.length} гипотез: сначала бесплатная проверка placeId, затем Pro только для запросов с новыми IDs.`,
        requiresConfirmation: true,
        expectedRequests: queries.length * 2,
        minimumRequests: queries.length,
        maximumRequests: queries.length * 2,
        resultsPerQuery: Math.min(options.resultsPerQuery || 10, 20),
        parameters: [
          { label: "Минимальный рейтинг", value: String(ctx.source.minRating) },
          { label: "IDs-only", value: `${queries.length} максимум` },
          { label: "Pro", value: `${queries.length} максимум` },
          {
            label: "Pro осталось локально",
            value: `${quota.bySku.pro.remaining}/${quota.bySku.pro.limit}`,
          },
          { label: "Enterprise", value: "0 · не используется" },
        ],
        warnings: [quota.note],
        limits: { maxItems: options.maxItems || queries.length * 10 },
      };
    },
    async sync() {
      throw new Error(
        "Google Places API (New) запускается через MCP; выполненный Pro/Enterprise-поиск сохраняет локальные Place-карточки автоматически.",
      );
    },
    normalize(item) {
      const payload = item.payload as { normalized?: unknown };
      return entitySchema.parse(payload.normalized);
    },
  },
);

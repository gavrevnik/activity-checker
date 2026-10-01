import { entitySchema, type NormalizedEntity } from "../../../shared/model.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
import {
  foursquarePlaceSchema,
  searchFoursquarePlaces,
  type FoursquarePlace,
} from "./client.js";
import { foursquareQuotaStatus } from "./quota.js";

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

function projectCategory(categories: string[]) {
  const value = categories.join(" ").toLowerCase();
  if (/sport|fitness|gym|recreation|stadium|court/.test(value)) return "Спорт";
  if (/art|museum|gallery|theat|music|concert/.test(value)) return "Искусство";
  if (/food|restaurant|cafe|coffee|bar|wine|brew/.test(value))
    return "Еда и напитки";
  if (/school|education|college|university|class/.test(value))
    return "Обучение";
  return "Другое";
}

function openingHours(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const display = (value as { display?: unknown }).display;
  if (Array.isArray(display))
    return display
      .filter((item): item is string => typeof item === "string")
      .join("\n");
  return typeof display === "string" ? display : "";
}

export function foursquareEntity(
  input: FoursquarePlace,
  ctx: ProviderContext,
): NormalizedEntity {
  const place = foursquarePlaceSchema.parse(input);
  const location = place.location || {};
  const categories = place.categories
    .map((category) => category.name)
    .filter(Boolean);
  const address =
    location.formatted_address ||
    [
      place.address || location.address,
      place.locality || location.locality,
      place.postcode || location.postcode,
    ]
      .filter(Boolean)
      .join(", ");
  const website = absoluteUrl(place.website);
  return entitySchema.parse({
    type: "Place",
    title: place.name,
    description: [
      place.description || "",
      place.rating !== undefined ? `Рейтинг Foursquare: ${place.rating}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    country: (place.country || location.country || ctx.scope.country)
      .slice(0, 2)
      .toUpperCase(),
    city: place.locality || location.locality || ctx.scope.city || "",
    category: projectCategory(categories),
    rawCategory: categories.join(", "),
    tags: ["foursquare", ...categories].slice(0, 50),
    address,
    latitude: place.latitude ?? null,
    longitude: place.longitude ?? null,
    url: `https://foursquare.com/v/${encodeURIComponent(place.fsq_place_id)}`,
    website,
    phone: place.tel || "",
    price: place.price ? "$".repeat(place.price) : "",
    openingHours: openingHours(place.hours),
    externalId: place.fsq_place_id,
    knownIds: { foursquare: place.fsq_place_id },
  });
}

export function foursquareRawItem(
  place: FoursquarePlace,
  ctx: ProviderContext,
): RawItem {
  const normalized = foursquareEntity(place, ctx);
  return {
    externalId: place.fsq_place_id,
    url: normalized.url,
    rawText: [normalized.title, normalized.description, normalized.address]
      .filter(Boolean)
      .join("\n"),
    payload: { original: place, normalized },
  };
}

function queries(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n\r]+|\s*;\s*/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

export const foursquare = defineProvider(
  {
    id: "foursquare",
    name: "Foursquare Places",
    group: "MCP",
    providerType: "Places API MCP",
    supportedEntityTypes: ["Place"],
    supportedScopes: ["*"],
    implemented: true,
    mode: "discovery",
    configFields: ["scope", "keyword"],
    description: "MCP · Поиск мест Foursquare по ключевым гипотезам.",
    credentials: [{ key: "FOURSQUARE_API_KEY", label: "Service API key" }],
    registration: {
      service: "Foursquare Developer",
      url: "https://foursquare.com/developers/",
    },
    manualSyncOnly: true,
    requiresSyncConfirmation: true,
    modelCallable: true,
    mcpServer: "Activity Checker Foursquare",
    mcpTools: [
      {
        name: "foursquare_status",
        description:
          "Показывает наличие ключа и локальный остаток бесплатной месячной квоты без API-запроса.",
      },
      {
        name: "foursquare_search_places",
        description:
          "Планирует или явно выполняет поиск мест по ключевикам и географии.",
      },
    ],
    docs: [
      {
        label: "Places Search API",
        url: "https://docs.foursquare.com/fsq-developers-places/reference/place-search",
      },
      {
        label: "Квоты и цены",
        url: "https://docs.foursquare.com/developer/reference/upcoming-changes",
      },
    ],
    steps: [
      "Добавьте до 10 поисковых гипотез по одной на строку.",
      "MCP сначала возвращает бесплатный план; реальный запрос требует execute=true.",
      "Локальный счётчик блокирует запросы после 500 вызовов за календарный месяц.",
    ],
    limitations:
      "500 бесплатных Pro-запросов в месяц. После этого официальный тариф начинается с $15 за 1 000 вызовов; локальный MCP жёстко останавливается на 500 и не разрешает автоматический переход к оплате.",
  },
  {
    async testConnection(ctx) {
      const result = await searchFoursquarePlaces({
        query: "coffee",
        near: ctx.scope.city ? `${ctx.scope.city}, Serbia` : "Serbia",
        limit: 1,
        apiKey: ctx.secrets.FOURSQUARE_API_KEY || "",
      });
      return `Foursquare Places API отвечает. Использован 1 запрос; локальный остаток: ${result.quota.remaining}/${result.quota.limit}.`;
    },
    async planSync(ctx, options) {
      const selected = queries(ctx.source.keyword);
      if (!selected.length)
        throw new Error("Добавьте хотя бы одну поисковую гипотезу.");
      const quota = foursquareQuotaStatus();
      return {
        sourceId: ctx.source.id,
        providerId: "foursquare",
        title: "Foursquare Places · план запросов",
        summary: `${selected.length} гипотез; каждая использует один Pro API-вызов.`,
        requiresConfirmation: true,
        expectedRequests: selected.length,
        minimumRequests: selected.length,
        maximumRequests: selected.length,
        resultsPerQuery: options.resultsPerQuery || 10,
        parameters: [
          { label: "Гипотезы", value: String(selected.length) },
          {
            label: "Локальная квота",
            value: `${quota.remaining}/${quota.limit} осталось за ${quota.month}`,
          },
        ],
        warnings: [
          "Запросы после локального лимита 500 за календарный месяц блокируются, чтобы не перейти на платный тариф.",
        ],
        limits: { maxItems: options.maxItems || selected.length * 10 },
      };
    },
    async sync(ctx, options = { confirmed: false }) {
      const selected = queries(ctx.source.keyword);
      if (!selected.length)
        throw new Error("Добавьте хотя бы одну поисковую гипотезу.");
      const limit = Math.min(options.resultsPerQuery || 10, 50);
      const maxItems = Math.min(
        options.maxItems || selected.length * limit,
        500,
      );
      const unique = new Map<string, FoursquarePlace>();
      let quota = foursquareQuotaStatus();
      let requestCount = 0;
      for (const query of selected) {
        const result = await searchFoursquarePlaces({
          query,
          near: ctx.scope.city ? `${ctx.scope.city}, Serbia` : "Serbia",
          limit,
          apiKey: ctx.secrets.FOURSQUARE_API_KEY || "",
        });
        requestCount += 1;
        quota = result.quota;
        for (const place of result.places) {
          unique.set(place.fsq_place_id, place);
          if (unique.size >= maxItems) break;
        }
        if (unique.size >= maxItems) break;
      }
      return {
        items: [...unique.values()].map((place) =>
          foursquareRawItem(place, ctx),
        ),
        warnings: [
          `Foursquare: использовано ${requestCount} запросов; локальный остаток ${quota.remaining}/${quota.limit}.`,
        ],
      };
    },
    normalize(item) {
      const payload = item.payload as { normalized?: unknown };
      return entitySchema.parse(payload.normalized);
    },
  },
);

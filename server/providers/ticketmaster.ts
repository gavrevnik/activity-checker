import { defineProvider, type ProviderContext } from "./types.js";
import { fetchJson } from "./http.js";
const request = (ctx: ProviderContext, page = 0, size = 200) => {
  const u = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
  u.search = new URLSearchParams({
    apikey: ctx.secrets.TICKETMASTER_API_KEY!,
    countryCode: ctx.scope.country,
    size: String(size),
    page: String(page),
    sort: "date,asc",
    ...(ctx.scope.city ? { city: ctx.scope.city } : {}),
    ...(ctx.source.keyword ? { keyword: ctx.source.keyword } : {}),
  }).toString();
  return fetchJson(u.href);
};
export const ticketmaster = defineProvider(
  {
    id: "ticketmaster",
    name: "Ticketmaster",
    group: "Международные",
    providerType: "API",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["*"],
    implemented: true,
    mode: "ingestion",
    description: "События из Discovery API; покрытие зависит от страны.",
    credentials: [{ key: "TICKETMASTER_API_KEY", label: "Consumer key" }],
    registration: {
      service: "Ticketmaster Developer",
      url: "https://developer.ticketmaster.com/",
    },
    docs: [
      {
        label: "Получить API key",
        url: "https://developer.ticketmaster.com/products-and-docs/tutorials/events-search/search_events_with_discovery_api.html",
      },
      {
        label: "Discovery API",
        url: "https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/",
      },
    ],
    steps: [
      "Создайте приложение в Ticketmaster Developer Portal.",
      "Скопируйте Consumer key в TICKETMASTER_API_KEY в .env.local.",
      "Включите источник → «Проверить» → «Синхронизировать». Ключ перечитывается автоматически.",
    ],
    limitations:
      "Для Сербии результат может быть пустым. До 1 000 событий за запуск; запросы ограничены глубиной Discovery API.",
  },
  {
    async testConnection(ctx) {
      await request(ctx, 0, 1);
      return "Ключ принят Ticketmaster. Наличие событий проверяется при синхронизации.";
    },
    async sync(ctx) {
      const items = [];
      const warnings = [];
      for (let page = 0; page < 5; page++) {
        const data = await request(ctx, page);
        for (const r of data._embedded?.events || [])
          items.push({
            externalId: r.id,
            url: r.url || "",
            rawText: [r.name, r.info, r.pleaseNote].filter(Boolean).join("\n"),
            payload: r,
          });
        if ((data.page?.totalPages || 0) <= page + 1) break;
        if (page === 4)
          warnings.push(
            "Загружены первые 1 000 событий. Уточните ключевое слово для большей полноты.",
          );
      }
      return { items, warnings };
    },
    normalize(item, ctx) {
      const r = item.payload as any,
        v = r._embedded?.venues?.[0];
      return {
        type: "Event",
        title: r.name,
        description: [r.info, r.pleaseNote].filter(Boolean).join("\n"),
        url: item.url,
        country: v?.country?.countryCode || ctx.scope.country,
        city: v?.city?.name || ctx.scope.city || "",
        startAt: r.dates?.start?.dateTime || r.dates?.start?.localDate || "",
        venue: v?.name || "",
        address: v?.address?.line1 || "",
        imageUrl:
          r.images?.find((i: any) => i.width >= 500)?.url ||
          r.images?.[0]?.url ||
          "",
        price:
          r.priceRanges
            ?.map((p: any) => `${p.min}–${p.max} ${p.currency}`)
            .join(", ") || "",
        category:
          r.classifications?.[0]?.segment?.name === "Music"
            ? "Музыка"
            : "Другое",
        rawCategory: r.classifications?.[0]?.segment?.name || "",
        knownIds: { ticketmaster: r.id },
      };
    },
  },
);

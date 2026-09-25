import { load } from "cheerio";
import { entitySchema } from "../../../shared/model.js";
import { localDay } from "../../../shared/dates.js";
import { nameKey } from "../../normalize.js";
import { fetchText } from "../http.js";
import { parseStructured } from "../structured.js";
import { defineProvider, type ProviderContext } from "../types.js";

const origin = "https://bilet.rs";
export function biletCity(venue: string): string {
  const text = nameKey(venue);
  for (const [pattern, city] of [
    [/\b(beograd|belgrade|zemun)\b/, "Belgrade"],
    [/\bnovi sad\b/, "Novi Sad"],
    [/\bleskovac\b/, "Leskovac"],
    [/\bnis\b/, "Niš"],
    [/\b(krusevac|krusevacko)\b/, "Kruševac"],
    [/\bkragujevac\b/, "Kragujevac"],
    [/\bkraljevo\b/, "Kraljevo"],
    [/\bsubotica\b/, "Subotica"],
  ] as const)
    if (pattern.test(text)) return city;
  return "";
}
function requestUrl(ctx: ProviderContext) {
  const source = new URL(ctx.source.url);
  if (
    !["bilet.rs", "www.bilet.rs", "app.bilet.rs"].includes(source.hostname) ||
    !["/", "/events", "/events/"].includes(source.pathname)
  )
    throw new Error(
      "Bilet.rs: укажите https://bilet.rs/events/; город берётся из географии источника.",
    );
  const url = new URL("/events/", origin);
  url.searchParams.set("countryCode", ctx.scope.country);
  url.searchParams.set("startDate", localDay(new Date(), ctx.scope.timezone));
  if (ctx.scope.city) url.searchParams.set("location", "Beograd");
  if (ctx.source.keyword) url.searchParams.set("title", ctx.source.keyword);
  return url;
}
export function parseBiletPage(
  body: string,
  url: string,
  ctx: ProviderContext,
) {
  const $ = load(body);
  // Carousel cards are outside the JSON-LD ItemList; only import the actual search results.
  const lists = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((node) => {
      try {
        const data = JSON.parse($(node).text());
        return data["@type"] === "ItemList" ? [data] : [];
      } catch {
        return [];
      }
    });
  if (lists.length !== 1 || !Array.isArray(lists[0].itemListElement))
    throw new Error(
      "Bilet.rs: список событий не найден. Возможно, сайт изменил формат.",
    );
  const cityFilter = $('input[name="location"]').attr("value") || "";
  if (ctx.scope.city && cityFilter !== "Beograd")
    throw new Error(
      "Bilet.rs не подтвердил фильтр Белграда. Импорт остановлен.",
    );
  const result = lists[0].itemListElement.length
    ? parseStructured(JSON.stringify(lists[0]), {
        ...ctx,
        source: { ...ctx.source, url, format: "jsonld" },
      })
    : { items: [], warnings: [] as string[] };
  let skipped = 0;
  result.items = result.items.filter((item) => {
    const path = new URL(item.url).pathname;
    const cards = $("article.card a.card-link").filter(
      (_, node) => $(node).attr("href") === path,
    );
    const venue = cards
      .last()
      .find(".meta-row .meta-item")
      .last()
      .text()
      .trim();
    const payload = item.payload as any;
    const city = biletCity(venue);
    if (ctx.scope.city && city && city !== "Belgrade") {
      skipped++;
      return false;
    }
    payload.normalized = entitySchema.parse({
      ...payload.normalized,
      city: city || (ctx.scope.city ? "Belgrade" : ""),
      venue,
    });
    payload.listing = { venue, cityFilter };
    item.rawText = [payload.normalized.title, venue].filter(Boolean).join("\n");
    return true;
  });
  if (skipped)
    result.warnings.push(
      `Bilet.rs: пропущены события другого города: ${skipped}.`,
    );
  const nextLink = $('a[aria-label="Sledeća strana"]');
  const href = nextLink.hasClass("is-disabled") ? "" : nextLink.attr("href");
  const next = href ? new URL(href, url) : null;
  if (next && (next.origin !== origin || !/^\/events\/?$/.test(next.pathname)))
    throw new Error("Bilet.rs: неподдерживаемая ссылка следующей страницы.");
  // Keep the same scope and search even if a site's pagination drops parameters.
  if (next)
    for (const [key, value] of new URL(url).searchParams)
      if (key !== "page") next.searchParams.set(key, value);
  return { ...result, next: next?.href || "" };
}
export default defineProvider(
  {
    id: "bilet",
    name: "Bilet.rs",
    group: "Местные афиши",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade", "serbia"],
    implemented: true,
    mode: "ingestion",
    defaultUrl: `${origin}/events/`,
    credentials: [],
    description: "Билетная афиша с фильтром города и обходом страниц.",
    docs: [{ label: "Афиша Bilet.rs", url: `${origin}/events/` }],
    steps: [
      "Ключ и регистрация не нужны. Укажите https://bilet.rs/events/ и выберите географию.",
      "Включите источник → «Проверить» → «Синхронизировать». Поиск по названию задаётся ключевым словом.",
    ],
    limitations:
      "До 30 страниц за запуск. Для Белграда используется поиск Beograd в локациях сайта: площадки без этого указания могут не попасть в выборку. Город из текста площадки имеет приоритет. Для всей Сербии неизвестный город остаётся пустым. Цены и полные описания список не отдаёт.",
  },
  {
    async testConnection(ctx) {
      const url = requestUrl(ctx).href;
      const result = parseBiletPage(await fetchText(url), url, ctx);
      return `Bilet.rs доступен без ключа. На первой странице: ${result.items.length}; фильтр географии проверен.`;
    },
    async sync(ctx) {
      let url = requestUrl(ctx).href;
      const items = new Map();
      const warnings: string[] = [];
      const visited = new Set<string>();
      const fingerprints = new Set<string>();
      for (let page = 0; url; page++) {
        if (page === 30) {
          warnings.push(
            "Bilet.rs: достигнут лимит 30 страниц, выборка неполная. Сузьте ключевое слово.",
          );
          break;
        }
        if (visited.has(url))
          throw new Error("Bilet.rs повторяет страницу; импорт остановлен.");
        visited.add(url);
        const result = parseBiletPage(await fetchText(url), url, ctx);
        const fingerprint = result.items
          .map((x) => x.externalId)
          .sort()
          .join("|");
        if (fingerprint && fingerprints.has(fingerprint))
          throw new Error("Bilet.rs повторяет события на следующей странице.");
        fingerprints.add(fingerprint);
        for (const item of result.items) items.set(item.externalId, item);
        warnings.push(...result.warnings);
        url = result.next;
      }
      return { items: [...items.values()], warnings: [...new Set(warnings)] };
    },
    normalize(item) {
      return entitySchema.parse((item.payload as any).normalized);
    },
  },
);

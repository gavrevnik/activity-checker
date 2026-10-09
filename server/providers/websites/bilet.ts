import { parseListing } from "@personal-radar/connectors/bilet";
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
  const { list, cityFilter, venues, next } = parseListing(
    body,
    url,
    ctx.scope.city,
  );
  const result = list.itemListElement.length
    ? parseStructured(JSON.stringify(list), {
        ...ctx,
        source: { ...ctx.source, url, format: "jsonld" },
      })
    : { items: [], warnings: [] as string[] };
  let skipped = 0;
  result.items = result.items.filter((item) => {
    const path = new URL(item.url).pathname;
    const venue = venues[path] || "";
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
  return { ...result, next };
}
export default defineProvider(
  {
    id: "bilet",
    name: "Bilet.rs",
    group: "API Агрегаторы",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade", "serbia"],
    implemented: true,
    mode: "ingestion",
    configFields: ["scope", "url", "keyword"],
    defaultUrl: `${origin}/events/`,
    credentials: [],
    description: "Билетная афиша с фильтром города и обходом страниц.",
    docs: [{ label: "Афиша Bilet.rs", url: `${origin}/events/` }],
    steps: [
      "Ключ и регистрация не нужны. Укажите https://bilet.rs/events/ и выберите географию.",
      "Единая кнопка блока API Агрегаторы запускает источник. Поиск по названию задаётся ключевым словом.",
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

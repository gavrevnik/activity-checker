import { load } from "cheerio";
import { entitySchema } from "../../../shared/model.js";
import { parseCalendarInput } from "../../../shared/dates.js";
import { nameKey } from "../../normalize.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";

const origin = "https://afisha.rs";
const maxPages = 100;
const excludedSectionPaths = new Set(["/ru/deti", "/ru/kino"]);

import {
  eventSchema,
  pageSchema,
  sourceUrl,
  readPage as fetchAfishaPage,
} from "@personal-radar/connectors/afisha";
function safeUrl(value: string | null | undefined, localOnly = false) {
  if (!value) return "";
  try {
    const url = new URL(value, origin);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return "";
    if (localOnly && url.origin !== origin) return "";
    return url.href;
  } catch {
    return "";
  }
}

function plainHtml(value: string | null | undefined) {
  return value ? load(value).text().replace(/\s+/g, " ").trim() : "";
}

function eventTime(value: string | null | undefined) {
  if (!value || value === "00:00:00") return "";
  return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
    ? value.slice(0, 5)
    : value;
}

function normalizedPath(value: string | null | undefined) {
  if (!value) return "";
  try {
    return new URL(value, origin).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function excludedEvent(
  eventUrl: string,
  sectionSlug: string | null | undefined,
) {
  const eventPath = normalizedPath(eventUrl);
  const sectionPath = normalizedPath(sectionSlug);
  if (!eventPath.startsWith("/ru/")) return "locale" as const;
  if (sectionPath && !sectionPath.startsWith("/ru/")) return "locale" as const;
  if (
    excludedSectionPaths.has(sectionPath) ||
    [...excludedSectionPaths].some((path) => eventPath.startsWith(`${path}/`))
  )
    return "section" as const;
  return "" as const;
}

function categoryFor(section: string) {
  const value = nameKey(section);
  if (value.includes("концерт")) return "Музыка";
  if (value.includes("кино")) return "Кино";
  if (value.includes("игр")) return "Игры";
  if (value.includes("мастер") || value.includes("лекц")) return "Обучение";
  if (value.includes("экскурс")) return "Прогулки";
  if (value.includes("stand up")) return "Общение";
  if (value.includes("театр") || value.includes("фестивал")) return "Искусство";
  return "Другое";
}

export function parseAfishaPage(value: unknown, ctx: ProviderContext) {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Afisha.rs изменил формат списка событий.");
  const items: RawItem[] = [];
  const warnings: string[] = [];
  let excludedCount = 0;
  for (const raw of parsed.data.items) {
    const event = eventSchema.safeParse(raw);
    if (!event.success) {
      warnings.push("Afisha.rs: пропущена карточка с неполными данными.");
      continue;
    }
    try {
      const id = String(event.data.id);
      const url = safeUrl(event.data.url, true);
      if (!url) throw new Error("invalid event URL");
      const exclusion = excludedEvent(url, event.data.section?.slug);
      if (exclusion === "section") {
        excludedCount++;
        continue;
      }
      if (exclusion === "locale") {
        warnings.push(
          `Afisha.rs: карточка ${id} вне русскоязычного раздела /ru пропущена.`,
        );
        continue;
      }
      const startAt = parseCalendarInput(
        event.data.date,
        eventTime(event.data.time),
        ctx.scope.timezone,
      );
      const endAt =
        event.data.date2 && event.data.date2 !== event.data.date
          ? parseCalendarInput(event.data.date2, "", ctx.scope.timezone)
          : "";
      const rawCategory = event.data.section?.title.trim() || "";
      const venue = event.data.venue?.title.trim() || "";
      const description = plainHtml(event.data.description).slice(0, 20_000);
      const rawPrice =
        event.data.price === null || event.data.price === undefined
          ? ""
          : String(event.data.price).trim();
      const price = rawPrice ? `${rawPrice} RSD` : "";
      const normalized = entitySchema.parse({
        type: "Event",
        title: event.data.title,
        description,
        country: "RS",
        city: "Belgrade",
        category: categoryFor(rawCategory),
        rawCategory,
        tags: rawCategory ? [rawCategory] : [],
        startAt,
        endAt,
        venue,
        url,
        website: safeUrl(event.data.ticket_link),
        imageUrl: safeUrl(
          event.data.image_styles?.original ||
            event.data.image_styles?.thumb640x360,
        ),
        price,
        externalId: id,
        knownIds: { afisha_rs: id },
      });
      items.push({
        externalId: id,
        url,
        rawText: [
          normalized.title,
          description,
          normalized.startAt,
          normalized.endAt,
          venue,
          rawCategory,
          price,
        ]
          .filter(Boolean)
          .join("\n"),
        payload: { original: event.data, normalized },
      });
    } catch {
      warnings.push(
        `Afisha.rs: карточка ${String(event.data.id)} содержит некорректную дату или URL и пропущена.`,
      );
    }
  }
  return {
    items,
    warnings: [...new Set(warnings)],
    pageCount: parsed.data.page_count,
    itemCount: parsed.data.item_count,
    rawCount: parsed.data.items.length,
    excludedCount,
  };
}

async function readPage(ctx: ProviderContext, page: number) {
  return parseAfishaPage(await fetchAfishaPage(ctx, page), ctx);
}

async function politePause() {
  if (process.env.NODE_ENV === "test") return;
  await new Promise((resolve) =>
    setTimeout(resolve, 150 + Math.floor(Math.random() * 101)),
  );
}

export default defineProvider(
  {
    id: "afisha",
    name: "Afisha.rs",
    group: "API Агрегаторы",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade"],
    implemented: true,
    mode: "ingestion",
    configFields: ["url"],
    defaultUrl: `${origin}/ru`,
    credentials: [],
    description:
      "Полная русскоязычная афиша Белграда из публичного списка Afisha.rs.",
    docs: [{ label: "Открыть Afisha.rs", url: `${origin}/ru` }],
    steps: [
      "Регистрация и API-ключ не нужны. URL: https://afisha.rs/ru; география: Белград.",
      "Запуск читает русский общий список и все объявленные им страницы; разделы «Дети» и «Кино» пропускаются.",
    ],
    limitations:
      "Используется недокументированный публичный JSON-интерфейс /ru. Страницы загружаются последовательно с короткой паузой, максимум 100 страниц за запуск. Главная и отдельные разделы повторно не обходятся, потому что общий список уже содержит их события. Разделы /ru/deti и /ru/kino исключены. При изменении формата импорт останавливается или сообщает о пропущенных карточках.",
  },
  {
    async testConnection(ctx) {
      const result = await readPage(ctx, 0);
      return `Afisha.rs доступен без ключа. На первой странице: ${result.items.length}; всего заявлено: ${result.itemCount} на ${result.pageCount} страницах.`;
    },
    async sync(ctx) {
      const first = await readPage(ctx, 0);
      const items = new Map<string, RawItem>();
      const warnings = [...first.warnings];
      const fingerprints = new Set<string>();
      let duplicateCount = 0;
      let rawCount = first.rawCount;
      let excludedCount = first.excludedCount;
      const addPage = (page: typeof first, index: number) => {
        const fingerprint = page.items
          .map((item) => item.externalId)
          .sort()
          .join("|");
        if (fingerprint && fingerprints.has(fingerprint))
          throw new Error(
            `Afisha.rs повторил события на странице ${index}; импорт остановлен.`,
          );
        fingerprints.add(fingerprint);
        for (const item of page.items) {
          if (items.has(item.externalId)) duplicateCount++;
          items.set(item.externalId, item);
        }
      };
      addPage(first, 0);
      for (let page = 1; page < first.pageCount; page++) {
        await politePause();
        const result = await readPage(ctx, page);
        rawCount += result.rawCount;
        excludedCount += result.excludedCount;
        warnings.push(...result.warnings);
        if (!result.rawCount)
          throw new Error(
            `Afisha.rs вернул пустую промежуточную страницу ${page}; импорт остановлен.`,
          );
        if (
          result.pageCount !== first.pageCount ||
          result.itemCount !== first.itemCount
        )
          warnings.push(
            "Afisha.rs изменил число событий во время загрузки; сохранён согласованный набор полученных страниц.",
          );
        addPage(result, page);
      }
      if (duplicateCount)
        warnings.push(
          `Afisha.rs: до записи схлопнуто повторов по ID: ${duplicateCount}.`,
        );
      if (excludedCount)
        warnings.push(
          `Afisha.rs: пропущены разделы «Дети» и «Кино»: ${excludedCount}.`,
        );
      if (rawCount !== first.itemCount)
        warnings.push(
          `Afisha.rs: сайт заявил ${first.itemCount} записей, получено ${rawCount}.`,
        );
      return { items: [...items.values()], warnings: [...new Set(warnings)] };
    },
    normalize(item) {
      return entitySchema.parse(
        (item.payload as { normalized: unknown }).normalized,
      );
    },
  },
);

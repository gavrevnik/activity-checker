import { entitySchema } from "../../../shared/model.js";
import { fromLocalDateTime, localDay } from "../../../shared/dates.js";
import { canonicalUrl } from "../../normalize.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
import { fetchText } from "../http.js";

const origin = "https://belgrade-beat.com";
const pages = ["/events/this-week", "/events/next-week"] as const;
import {
  belgradeBeatDay as parseDay,
  parseBelgradeBeatPage as parsePage,
} from "@personal-radar/connectors/belgrade-beat";
export const belgradeBeatDay = (heading: string, today = localDay()) =>
  parseDay(heading, today);
function categoryFor(tags: string[]) {
  const value = tags.join(" ").toLowerCase();
  if (/concert|music/.test(value)) return "Музыка";
  if (/art|culture/.test(value)) return "Искусство";
  if (/sport|adrenaline/.test(value)) return "Спорт";
  if (/food|drink/.test(value)) return "Еда и напитки";
  if (/educational/.test(value)) return "Обучение";
  if (/activity|experience/.test(value)) return "Прогулки";
  return "Другое";
}

export function parseBelgradeBeatPage(
  html: string,
  pageUrl: string,
  ctx: ProviderContext,
  today = localDay(new Date(), ctx.scope.timezone),
) {
  return parsePage(html, pageUrl, today, (entry): RawItem => {
    const {
      externalId,
      headingDay: day,
      time,
      title,
      description,
      venues,
      tags,
      url,
      imageUrl,
      ...rest
    } = entry;
    const normalized = entitySchema.parse({
      type: "Event",
      title,
      description,
      country: "RS",
      city: "Belgrade",
      category: categoryFor(tags),
      rawCategory: tags.join(", "),
      tags,
      startAt: time ? fromLocalDateTime(day, time, ctx.scope.timezone) : day,
      venue: venues.join(", "),
      url,
      imageUrl,
      externalId,
      knownIds: { belgrade_beat: externalId },
    });
    return {
      externalId,
      url,
      rawText: [title, description, normalized.startAt, normalized.venue]
        .filter(Boolean)
        .join("\n"),
      payload: {
        original: {
          ...rest,
          headingDay: day,
          title,
          description,
          venues,
          tags,
          url,
          imageUrl,
        },
        normalized,
      },
    };
  });
}

export function dedupeBelgradeBeatItems(items: RawItem[]) {
  const selected = new Map<string, RawItem>();
  let duplicates = 0;
  for (const item of items) {
    const key = canonicalUrl(item.url);
    if (!key) continue;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, item);
      continue;
    }
    duplicates++;
    const currentStart = String(
      (current.payload as { normalized?: { startAt?: string } }).normalized
        ?.startAt || "",
    );
    const nextStart = String(
      (item.payload as { normalized?: { startAt?: string } }).normalized
        ?.startAt || "",
    );
    if (nextStart && (!currentStart || nextStart < currentStart))
      selected.set(key, item);
  }
  return { items: [...selected.values()], duplicates };
}

async function politePause() {
  if (process.env.NODE_ENV === "test") return;
  await new Promise((resolve) =>
    setTimeout(resolve, 2000 + Math.floor(Math.random() * 1001)),
  );
}

export default defineProvider(
  {
    id: "belgrade-beat",
    name: "Belgrade Beat",
    group: "API Агрегаторы",
    providerType: "Website/Aggregator",
    mode: "ingestion",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade"],
    implemented: true,
    configFields: [],
    defaultUrl: `${origin}/events/this-week`,
    credentials: [],
    description:
      "События текущей и следующей недели из публичного календаря Belgrade Beat.",
    docs: [
      { label: "Эта неделя", url: `${origin}/events/this-week` },
      { label: "Следующая неделя", url: `${origin}/events/next-week` },
    ],
    steps: [
      "Единая кнопка блока API Агрегаторы читает текущую и следующую недели.",
      "Повторы по event URL схлопываются до записи; сохраняется самая ранняя дата.",
    ],
    limitations:
      "Два последовательных HTML-запроса за запуск с паузой 2–3 секунды. Детальные страницы не обходятся; при HTTP 429 повторов нет. Многодневные повторы одного event URL сохраняются одной карточкой с самой ранней датой.",
  },
  {
    async testConnection(ctx) {
      const result = parseBelgradeBeatPage(
        await fetchText(`${origin}${pages[0]}`),
        `${origin}${pages[0]}`,
        ctx,
      );
      const unique = dedupeBelgradeBeatItems(result.items);
      return `Belgrade Beat доступен. На странице этой недели: ${unique.items.length} уникальных событий; повторов по URL: ${unique.duplicates}.`;
    },
    async sync(ctx) {
      const all: RawItem[] = [];
      const warnings: string[] = [];
      for (let index = 0; index < pages.length; index++) {
        if (index) await politePause();
        const url = `${origin}${pages[index]}`;
        const result = parseBelgradeBeatPage(await fetchText(url), url, ctx);
        all.push(...result.items);
        warnings.push(...result.warnings);
      }
      const unique = dedupeBelgradeBeatItems(all);
      if (unique.duplicates)
        warnings.push(
          `Belgrade Beat: до записи схлопнуто повторов по event URL: ${unique.duplicates}; оставлена самая ранняя дата.`,
        );
      return { items: unique.items, warnings: [...new Set(warnings)] };
    },
    normalize(item) {
      return entitySchema.parse(
        (item.payload as { normalized: unknown }).normalized,
      );
    },
  },
);

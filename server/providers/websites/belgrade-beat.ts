import { load } from "cheerio";
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
const months = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index]),
);

function addDays(day: string, count: number) {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function belgradeBeatDay(heading: string, today = localDay()) {
  const normalized = heading.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.includes("today's events")) return today;
  if (normalized.includes("tomorrow's events")) return addDays(today, 1);
  const match =
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+events/i.exec(
      normalized,
    );
  if (!match) return "";
  const month = months.get(match[1].toLowerCase());
  const day = Number(match[2]);
  if (month === undefined || day < 1 || day > 31) return "";
  const current = new Date(`${today}T12:00:00Z`);
  const candidates = [-1, 0, 1]
    .map(
      (offset) =>
        new Date(Date.UTC(current.getUTCFullYear() + offset, month, day, 12)),
    )
    .filter(
      (candidate) =>
        candidate.getUTCMonth() === month && candidate.getUTCDate() === day,
    )
    .sort(
      (a, b) =>
        Math.abs(a.getTime() - current.getTime()) -
        Math.abs(b.getTime() - current.getTime()),
    );
  return candidates[0]?.toISOString().slice(0, 10) || "";
}

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

function absolute(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.href : "";
  } catch {
    return "";
  }
}

export function parseBelgradeBeatPage(
  html: string,
  pageUrl: string,
  ctx: ProviderContext,
  today = localDay(new Date(), ctx.scope.timezone),
) {
  const $ = load(html);
  const items: RawItem[] = [];
  const warnings: string[] = [];
  let day = "";
  let eventNodes = 0;
  $("h2.mt0.pt4.f2x.ttu, .js-event").each((_, element) => {
    const node = $(element);
    if (element.tagName === "h2") {
      day = belgradeBeatDay(node.text(), today);
      if (!day)
        warnings.push(
          `Belgrade Beat: не распознана дата раздела «${node.text().replace(/\s+/g, " ").trim()}».`,
        );
      return;
    }
    eventNodes++;
    const card = node.children(".dn.db-ns.rowx").first();
    const link = card.find('a[href^="/events/"]').first();
    const url = absolute(link.attr("href"));
    const title = card.find("h2").first().text().replace(/\s+/g, " ").trim();
    if (!day || !url || !title) {
      warnings.push("Belgrade Beat: неполная карточка события пропущена.");
      return;
    }
    const description = card
      .find(".colx.w-75 > .mt2.tj")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const from = card
      .find(".colx.w-75 > .mt2")
      .filter((_, row) => $(row).text().includes("From:"))
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const time = /\b([01]\d|2[0-3]):[0-5]\d\b/.exec(from)?.[0] || "";
    const venues = card
      .find('a[href^="/venues/"]')
      .toArray()
      .map((venue) => $(venue).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const tags = card
      .find(".mt1 .gold")
      .toArray()
      .map((tag) => $(tag).text().replace(/\s+/g, " ").trim())
      .filter((tag, index, all) => !!tag && all.indexOf(tag) === index);
    const imageUrl = absolute(card.find("img").first().attr("src"));
    const externalId = new URL(url).pathname.replace(/^\/events\//, "");
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
    items.push({
      externalId,
      url,
      rawText: [title, description, normalized.startAt, normalized.venue]
        .filter(Boolean)
        .join("\n"),
      payload: {
        original: {
          pageUrl,
          headingDay: day,
          title,
          description,
          from,
          venues,
          tags,
          url,
          imageUrl,
        },
        normalized,
      },
    });
  });
  if (!eventNodes)
    throw new Error(
      "Belgrade Beat: структура страницы изменилась — карточки .js-event не найдены.",
    );
  if (!items.length)
    throw new Error(
      "Belgrade Beat: карточки найдены, но ни одну не удалось распознать.",
    );
  return { items, warnings };
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

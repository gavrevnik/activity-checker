import { load } from "cheerio";
import { z } from "zod";
import { entitySchema } from "../../../shared/model.js";
import { localDay, parseCalendarInput } from "../../../shared/dates.js";
import { normalize } from "../../normalize.js";
import { fetchJson } from "../http.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
const origin = "https://www.serbia.travel";
const endpoint = `${origin}/en/wp-json/event-listings/v1/get-events/`;
const responseSchema = z.object({ html: z.string(), hasMore: z.boolean() });
export function parseSerbiaCalendar(value: unknown, ctx: ProviderContext) {
  const response = responseSchema.safeParse(value);
  if (!response.success)
    throw new Error(
      "Serbia Travel изменил формат календаря; нужно обновить адаптер.",
    );
  const $ = load(response.data.html);
  const items: RawItem[] = [];
  const emptyNotice =
    !response.data.hasMore && $("body").text().trim() === "No events found.";
  if (response.data.html.trim() && !$(".event-item").length && !emptyNotice)
    throw new Error("Serbia Travel: карточки календаря не найдены.");
  $(".event-item").each((_, node) => {
    const card = $(node),
      title = card.find("h2").text().trim(),
      city = card.find(".city").text().trim();
    const url = new URL(card.find("a.event-link").attr("href") || "", origin);
    if (url.origin !== origin || !url.pathname.startsWith("/en/events/"))
      throw new Error("Serbia Travel: некорректная ссылка события.");
    const date = card.find(".date-from-to").text().trim();
    const dates = date.match(/\d{2}\.\d{2}\.\d{4}/g) || [];
    if (!title || !city || !dates.length || dates.length > 2)
      throw new Error(
        "Serbia Travel: у события отсутствует название, город или подтверждённая дата.",
      );
    const startAt = parseCalendarInput(dates[0]!, "", ctx.scope.timezone);
    const endAt = dates[1]
      ? parseCalendarInput(dates[1], "", ctx.scope.timezone)
      : "";
    const rawCategory = card.find(".categories").text().trim();
    const normalized = normalize({
      type: "Event",
      title,
      city,
      country: "RS",
      url: url.href,
      startAt,
      endAt,
      rawCategory,
      category: /music/i.test(rawCategory)
        ? "Музыка"
        : /art|cultural/i.test(rawCategory)
          ? "Искусство"
          : /sport/i.test(rawCategory)
            ? "Спорт"
            : /food|wine/i.test(rawCategory)
              ? "Еда и напитки"
              : "Другое",
    });
    if (ctx.scope.city && normalized.city !== ctx.scope.city) return;
    // Dates are part of the identity: the site can reuse an annual festival page.
    const externalId = `${card.find("[data-id]").attr("data-id") || url.pathname}:${startAt}`;
    items.push({
      externalId,
      url: url.href,
      rawText: [title, city, date, rawCategory].join("\n"),
      payload: {
        original: { title, city, date, rawCategory, url: url.href },
        normalized,
      },
    });
  });
  if (response.data.hasMore && !$(".event-item").length)
    throw new Error("Serbia Travel вернул пустую промежуточную страницу.");
  return { items, hasMore: response.data.hasMore };
}
async function read(ctx: ProviderContext, page: number) {
  const url = new URL(ctx.source.url);
  if (
    !["serbia.travel", "www.serbia.travel"].includes(url.hostname) ||
    !["/en/event-calendar/", "/en/event-calendar"].includes(url.pathname)
  )
    throw new Error(
      "Serbia Travel: укажите https://www.serbia.travel/en/event-calendar/.",
    );
  return parseSerbiaCalendar(
    await fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_filtered_events",
        keyword: ctx.source.keyword || "",
        location: ctx.scope.city || "",
        start_date: localDay(new Date(), ctx.scope.timezone),
        end_date: "",
        categories: [],
        lang: "en",
        page,
      }),
    }),
    ctx,
  );
}
export default defineProvider(
  {
    id: "serbia-travel",
    name: "Serbia Travel",
    group: "Местные афиши",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["serbia", "belgrade"],
    implemented: true,
    mode: "ingestion",
    credentials: [],
    defaultUrl: `${origin}/en/event-calendar/`,
    description:
      "Календарь Туристической организации Сербии: города, даты и категории.",
    docs: [
      { label: "Календарь Serbia Travel", url: `${origin}/en/event-calendar/` },
    ],
    steps: [
      "Регистрация и ключ не нужны. Оставьте URL английского календаря и выберите Сербию или Белград.",
      "Включите → «Проверить» → «Синхронизировать». Для поиска по названию задайте ключевое слово.",
    ],
    limitations:
      "Публичный интерфейс календаря, до 30 страниц. Даты без времени; цены и полные описания не загружаются. Для Белграда дополнительно проверяется город карточки. При изменении сайта адаптер может потребовать обновления.",
  },
  {
    async testConnection(ctx) {
      const r = await read(ctx, 1);
      return `Serbia Travel доступен без ключа. На первой странице: ${r.items.length} событий.`;
    },
    async sync(ctx) {
      const items = new Map<string, RawItem>(),
        warnings: string[] = [],
        seen = new Set<string>();
      for (let page = 1; page <= 30; page++) {
        const r = await read(ctx, page);
        const fingerprint = r.items.map((i) => i.externalId).join("|");
        if (fingerprint && seen.has(fingerprint))
          throw new Error("Serbia Travel повторяет страницу календаря.");
        seen.add(fingerprint);
        for (const item of r.items) items.set(item.externalId, item);
        if (!r.hasMore) break;
        if (page === 30)
          warnings.push(
            "Serbia Travel: достигнут лимит 30 страниц; выборка неполная.",
          );
      }
      return { items: [...items.values()], warnings };
    },
    normalize(item) {
      return entitySchema.parse((item.payload as any).normalized);
    },
  },
);

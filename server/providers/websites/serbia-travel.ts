import { entitySchema } from "../../../shared/model.js";
import { localDay, parseCalendarInput } from "../../../shared/dates.js";
import { normalize } from "../../normalize.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
const origin = "https://www.serbia.travel";
export function parseSerbiaCalendar(value: unknown, ctx: ProviderContext) {
  return parseCalendar(value, (entry): RawItem | null => {
    const { title, city, date, dates, rawCategory, url, id } = entry;
    const startAt = parseCalendarInput(dates[0]!, "", ctx.scope.timezone);
    const endAt = dates[1]
      ? parseCalendarInput(dates[1], "", ctx.scope.timezone)
      : "";
    const normalized = normalize({
      type: "Event",
      title,
      city,
      country: "RS",
      url,
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
    if (ctx.scope.city && normalized.city !== ctx.scope.city) return null;
    const externalId = `${id}:${startAt}`;
    return {
      externalId,
      url,
      rawText: [title, city, date, rawCategory].join("\n"),
      payload: {
        original: { title, city, date, rawCategory, url },
        normalized,
      },
    };
  });
}
import {
  read as readCalendar,
  parseCalendar,
} from "@personal-radar/connectors/serbia-travel";
async function read(ctx: ProviderContext, page: number) {
  return parseSerbiaCalendar(
    await readCalendar(ctx, page, localDay(new Date(), ctx.scope.timezone)),
    ctx,
  );
}
export default defineProvider(
  {
    id: "serbia-travel",
    name: "Serbia Travel",
    group: "API Агрегаторы",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["serbia", "belgrade"],
    implemented: true,
    mode: "ingestion",
    configFields: ["scope", "url", "keyword"],
    credentials: [],
    defaultUrl: `${origin}/en/event-calendar/`,
    description:
      "Календарь Туристической организации Сербии: города, даты и категории.",
    docs: [
      { label: "Календарь Serbia Travel", url: `${origin}/en/event-calendar/` },
    ],
    steps: [
      "Регистрация и ключ не нужны. Оставьте URL английского календаря и выберите Сербию или Белград.",
      "Единая кнопка блока API Агрегаторы запускает источник. Для поиска по названию задайте ключевое слово.",
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

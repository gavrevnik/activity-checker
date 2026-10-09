import { load } from "cheerio";
import { entitySchema } from "../../../shared/model.js";
import { localDay, parseCalendarInput } from "../../../shared/dates.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";

import {
  connect as connectTickets,
  eventSchema,
  maxPages,
  type Town,
} from "@personal-radar/connectors/tickets";
const origin = "https://tickets.rs";
const connect = (ctx: ProviderContext) =>
  connectTickets(ctx, localDay(new Date(), ctx.scope.timezone));

export function parseTicketsEvent(
  value: unknown,
  town: Town,
  ctx: ProviderContext,
): RawItem | null {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Неподдерживаемый формат записи Tickets.rs");
  const event = parsed.data;
  // Undated vouchers use artificial validity dates. Do not present them as scheduled events.
  if (!event.DateTime.trim()) return null;
  const clock = event.DateTime.match(
    /(?:^|\s)([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|[-–]|$)/,
  );
  const hour = event.DateTime.match(/(?:^|\s)([01]?\d|2[0-3])h(?=\s|$)/i);
  const time = clock
    ? `${clock[1].padStart(2, "0")}:${clock[2]}`
    : hour
      ? `${hour[1].padStart(2, "0")}:00`
      : "";
  // Some labels describe a series or ticket sales; their internal date is a placeholder.
  const hasDate = /\d/.test(event.DateTime);
  const startAt = hasDate
    ? parseCalendarInput(event.StartDate, time, ctx.scope.timezone)
    : "";
  const endAt =
    hasDate && event.EndDate && event.EndDate !== event.StartDate
      ? event.EndDate
      : "";
  const url = `${origin}/${event.Slug}`;
  const description = event.Desc ? load(event.Desc).text().trim() : "";
  const status = event.EventStatus?.trim() || "";
  const normalized = entitySchema.parse({
    type: "Event",
    title: event.Title,
    url,
    country: "RS",
    city: "Belgrade",
    description: [description, status && `Статус Tickets.rs: ${status}`]
      .filter(Boolean)
      .join("\n"),
    startAt,
    endAt,
    venue: event.Venue,
    imageUrl: event.ImgSrc ? new URL(event.ImgSrc, origin).href : "",
    // Zero also means 'price unavailable' on the site; it is not evidence of free admission.
    price: event.Price ? `от ${event.Price.toLocaleString("ru-RU")} RSD` : "",
    knownIds: { tickets: String(event.Id) },
  });
  return {
    externalId: String(event.Id),
    url,
    rawText: [event.Title, event.DateTime, event.Venue, description, status]
      .filter(Boolean)
      .join("\n"),
    payload: { original: value, town, normalized },
  };
}

export default defineProvider(
  {
    id: "tickets",
    name: "Tickets.rs",
    group: "API Агрегаторы",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade"],
    implemented: true,
    mode: "ingestion",
    configFields: ["url", "keyword"],
    defaultUrl: `${origin}/`,
    credentials: [],
    description: "Публичная афиша Белграда: события, даты, площадки и цены.",
    docs: [{ label: "Афиша Tickets.rs", url: `${origin}/` }],
    steps: [
      "Ключ и аккаунт не нужны. URL: https://tickets.rs/; география: Белград.",
      "Нажмите единую кнопку блока API Агрегаторы. Для более узкой выборки задайте ключевое слово.",
    ],
    limitations:
      "Пока только Белград, включая отдельные разделы города и Земуна. События с сегодняшнего дня, до 60 страниц за запуск; ваучеры без даты пропускаются. Категории и полные описания список не отдаёт, время бывает не указано. Это внутренний публичный интерфейс сайта: при его изменениях адаптер потребует обновления.",
  },
  {
    async testConnection(ctx) {
      const connection = await connect(ctx);
      const town = connection.towns[0];
      const data = await connection.page(town, 1);
      for (const value of data.Events) parseTicketsEvent(value, town, ctx);
      return `Афиша Tickets.rs доступна без ключа. ${town.Title}: ${data.TotalItems} записей; проверена первая страница.`;
    },
    async sync(ctx) {
      const connection = await connect(ctx);
      const items = new Map<string, RawItem>();
      const warnings: string[] = [];
      let pages = 0,
        undated = 0,
        invalid = 0;
      for (const town of connection.towns) {
        const seenPages = new Set<string>();
        for (let number = 1; ; number++) {
          if (pages >= maxPages) {
            warnings.push(
              `Достигнут лимит ${maxPages} страниц. Выборка неполная; сузьте ключевое слово.`,
            );
            break;
          }
          const data = await connection.page(town, number);
          pages++;
          const fingerprint = JSON.stringify(data.Events);
          if (data.Events.length && seenPages.has(fingerprint))
            throw new Error(
              "Tickets.rs повторил события на следующей странице; импорт остановлен.",
            );
          seenPages.add(fingerprint);
          for (const value of data.Events) {
            try {
              const item = parseTicketsEvent(value, town, ctx);
              if (!item) {
                undated++;
                continue;
              }
              items.set(item.externalId, item);
            } catch {
              invalid++;
            }
          }
          if (number * data.ItemsPerPage >= data.TotalItems) break;
        }
      }
      if (invalid && !items.size)
        throw new Error(
          "Tickets.rs: ни одну запись не удалось разобрать. Нужно обновить адаптер.",
        );
      if (undated)
        warnings.push(`Пропущены записи без конкретной даты: ${undated}.`);
      if (invalid)
        warnings.push(
          `Пропущены записи с неподдерживаемым форматом: ${invalid}.`,
        );
      return { items: [...items.values()], warnings };
    },
    normalize(item) {
      return entitySchema.parse(
        (item.payload as { normalized: unknown }).normalized,
      );
    },
  },
);

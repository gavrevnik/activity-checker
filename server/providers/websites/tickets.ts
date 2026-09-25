import { load } from "cheerio";
import { z } from "zod";
import { entitySchema } from "../../../shared/model.js";
import { localDay, parseCalendarInput } from "../../../shared/dates.js";
import { fetchJson } from "../http.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";

const origin = "https://tickets.rs";
const maxPages = 60;
const positiveId = z.number().int().positive();
const townSchema = z.object({ ID: positiveId, Title: z.string().min(1) });
const eventSchema = z.object({
  Id: positiveId,
  Slug: z.string().regex(/^event\/[\w-]+$/),
  Type: z.literal("event"),
  Title: z.string().trim().min(1).max(400),
  Desc: z.string().nullish(),
  DateTime: z.string(),
  StartDate: z.iso.date(),
  EndDate: z.union([z.iso.date(), z.literal("")]).nullish(),
  Venue: z.string(),
  Price: z.number().nonnegative().nullish(),
  EventStatus: z.string().nullish(),
  ImgSrc: z.string().nullish(),
});
const pageSchema = z.object({
  TotalItems: z.number().int().nonnegative(),
  ItemsPerPage: positiveId,
  CurrentPage: z.number().int().nonnegative(),
  Events: z.array(z.unknown()),
  Toolbar: z.object({
    Filters: z.array(
      z.object({
        Key: z.string(),
        Groups: z.array(
          z.object({
            Options: z.array(
              z.object({
                ID: z.number(),
                Selected: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
});
type Town = z.infer<typeof townSchema>;

// These are public website read operations, not a documented partner API.
// Fetch its public application configuration each run; never store session data.
async function connect(ctx: ProviderContext) {
  const url = new URL(ctx.source.url);
  if (
    !["tickets.rs", "www.tickets.rs"].includes(url.hostname) ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !["/", "/homepage", "/homepage/"].includes(url.pathname) ||
    url.search
  )
    throw new Error(
      "Tickets.rs: укажите https://tickets.rs/; город задаётся географией источника, поиск — ключевым словом.",
    );
  if (ctx.scope.id !== "belgrade")
    throw new Error(
      "Tickets.rs: этот адаптер пока поддерживает только Белград.",
    );
  const config = z
    .object({
      UserName: z.literal("tickets.rs"),
      UserType: z.union([z.literal("2"), z.literal(2)]),
      SessionCode: z.string().min(1).max(200),
    })
    .safeParse(await fetchJson(`${origin}/assets/app_config.json`, {}, 20000));
  if (!config.success)
    throw new Error(
      "Tickets.rs изменил публичную конфигурацию. Нужно обновить адаптер.",
    );
  async function read(
    sproc: "web__Get_PageConfig" | "web__Get_SearchMenu" | "web__Get_EventList",
    params: Record<string, unknown> = {},
  ) {
    const response = await fetchJson(
      `${origin}/web/api/data/agnosticget`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sproc,
          JSONParams: {
            ...config.data,
            WebSession: "",
            Lang: "SR",
            LayoutType: "search",
            Slug: "",
            ...params,
          },
        }),
      },
      20000,
    );
    const result = response?.d ?? response;
    if (
      result?.RetMessage !== "OK" ||
      !result.data ||
      typeof result.data !== "object"
    )
      throw new Error(
        "Tickets.rs не вернул данные афиши. Повторите позже; при повторной ошибке нужно проверить адаптер.",
      );
    return result.data;
  }
  const layout = await read("web__Get_PageConfig");
  function findWidget(value: unknown): number | undefined {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.Type === "event-list" && positiveId.safeParse(row.Id).success)
      return row.Id as number;
    for (const child of Object.values(row)) {
      const found = findWidget(child);
      if (found) return found;
    }
  }
  const widgetId = findWidget(layout.Layout);
  if (!widgetId)
    throw new Error(
      "Tickets.rs: виджет афиши не найден. Нужно обновить адаптер.",
    );
  const menu = await read("web__Get_SearchMenu");
  if (!Array.isArray(menu.Town))
    throw new Error("Tickets.rs: список городов не найден.");
  const towns = menu.Town.map((value: unknown) => townSchema.safeParse(value))
    .filter((value: z.ZodSafeParseResult<Town>) => value.success)
    .map((value: z.ZodSafeParseSuccess<Town>) => value.data)
    .filter((town: Town) =>
      /^(beograd(?:\s*\(.*\))?|novi beograd|belgrade)$/i.test(
        town.Title.trim(),
      ),
    );
  if (!towns.length)
    throw new Error("Tickets.rs: Белград отсутствует в списке городов.");
  const today = localDay(new Date(), ctx.scope.timezone);
  async function page(town: Town, number: number) {
    const result = pageSchema.safeParse(
      await read("web__Get_EventList", {
        WidgetID: widgetId,
        UsePaginator: true,
        CurrentPage: number,
        Search: {
          IDTown: town.ID,
          DateFrom: today,
          ...(ctx.source.keyword ? { Text: ctx.source.keyword } : {}),
        },
      }),
    );
    if (!result.success)
      throw new Error(
        `Tickets.rs: неподдерживаемый формат (${town.Title}, страница ${number}, поля ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}). Нужно обновить адаптер.`,
      );
    const data = result.data;
    // Empty districts use CurrentPage=0 and omit the selected town option.
    if (data.TotalItems === 0 && data.Events.length === 0) return data;
    const city = data.Toolbar.Filters.find((filter) => filter.Key === "IDTown");
    if (
      !city?.Groups.some((group) =>
        group.Options.some(
          (option) => option.ID === town.ID && option.Selected,
        ),
      )
    )
      throw new Error(
        "Tickets.rs не подтвердил фильтр города; импорт остановлен, чтобы не смешать географию.",
      );
    if (
      data.CurrentPage !== number ||
      (!data.Events.length &&
        (number - 1) * data.ItemsPerPage < data.TotalItems)
    )
      throw new Error(
        "Tickets.rs вернул неполную или повторную страницу. Попробуйте синхронизацию позже.",
      );
    return data;
  }
  return { towns: towns as Town[], page };
}

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
    group: "Местные афиши",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade"],
    implemented: true,
    mode: "ingestion",
    defaultUrl: `${origin}/`,
    credentials: [],
    description: "Публичная афиша Белграда: события, даты, площадки и цены.",
    docs: [{ label: "Афиша Tickets.rs", url: `${origin}/` }],
    steps: [
      "Ключ и аккаунт не нужны. URL: https://tickets.rs/; география: Белград.",
      "Включите источник и нажмите «Проверить» — проверяется чтение афиши.",
      "Нажмите «Синхронизировать». Для более узкой выборки задайте ключевое слово.",
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

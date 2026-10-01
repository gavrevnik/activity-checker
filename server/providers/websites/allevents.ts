import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { z } from "zod";
import {
  entitySchema,
  type SyncOptions,
  type SyncPlan,
} from "../../../shared/model.js";
import { fromLocalDateTime, localDay } from "../../../shared/dates.js";
import { validateRemote } from "../http.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";

const origin = "https://allevents.in";
const endpoint = `${origin}/api/index.php/categorization/web/v1/list`;
export const ALLEVENTS_ROWS = 50;
export const ALLEVENTS_MAX_PAGES = 20;
const ALLEVENTS_PREVIEW_TTL_MS = 10 * 60 * 1000;
const embeddedContinuationRows = 46;
const websitePageRows = 15;
const maxBytes = 20 * 1024 * 1024;
const blockStatuses = new Set([401, 403, 429, 502, 503, 504]);
export const allEventsCategories = [
  { value: "all", label: "Все события" },
  { value: "music", label: "Музыка" },
  { value: "concerts", label: "Концерты" },
  { value: "live-music", label: "Живая музыка" },
  { value: "parties", label: "Вечеринки" },
  { value: "comedy", label: "Комедия" },
  { value: "performances", label: "Представления" },
  { value: "theatre", label: "Театр" },
  { value: "art", label: "Искусство" },
  { value: "exhibitions", label: "Выставки" },
  { value: "festivals", label: "Фестивали" },
  { value: "sports", label: "Спорт" },
  { value: "workshops", label: "Мастер-классы" },
  { value: "meetups", label: "Встречи" },
  { value: "food-drinks", label: "Еда и напитки" },
  { value: "business", label: "Бизнес" },
  { value: "education", label: "Обучение" },
  { value: "technology", label: "Технологии" },
  { value: "kids", label: "Для детей" },
] as const;
const categoryValues = new Set(allEventsCategories.map((c) => c.value));
const epoch = z
  .union([z.number(), z.string()])
  .transform(Number)
  .pipe(z.number().int().nonnegative());
const eventSchema = z
  .object({
    event_id: z.union([z.string(), z.number()]).transform(String),
    eventname: z.string().nullish(),
    eventname_raw: z.string().nullish(),
    start_time: epoch,
    end_time: epoch.nullish(),
    location: z.string().nullish(),
    venue: z
      .object({
        street: z.string().nullish(),
        city: z.string().nullish(),
        state: z.string().nullish(),
        country: z.string().nullish(),
        latitude: z.union([z.number(), z.string()]).nullish(),
        longitude: z.union([z.number(), z.string()]).nullish(),
        full_address: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    event_url: z.string().nullish(),
    share_url: z.string().nullish(),
    banner_url: z.string().nullish(),
    thumb_url_large: z.string().nullish(),
    organizer: z
      .object({
        org_id: z.union([z.string(), z.number()]).nullish(),
        name: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    categories: z.array(z.unknown()).nullish(),
    tags: z.array(z.unknown()).nullish(),
    formats: z.array(z.unknown()).nullish(),
    tickets: z
      .object({
        has_tickets: z.boolean().nullish(),
        ticket_url: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    custom_params: z.record(z.string(), z.unknown()).nullish(),
    short_description: z.string().nullish(),
    timezone: z.string().nullish(),
  })
  .passthrough();

function addDays(day: string, days: number) {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function epochAtStart(day: string, timeZone: string) {
  return Math.floor(
    Date.parse(fromLocalDateTime(day, "00:00", timeZone)) / 1000,
  );
}
function safeUrl(value: unknown, host?: string) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, origin);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (!host || url.hostname === host || url.hostname.endsWith(`.${host}`))
      ? url.href
      : "";
  } catch {
    return "";
  }
}
function text(value: string | null | undefined) {
  return value
    ? load(`<body>${value}</body>`).text().replace(/\s+/g, " ").trim()
    : "";
}
function strings(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : [];
}
type Selection = {
  startDate: string;
  endDate: string;
  categories: string[];
};
type Preview = {
  id: string;
  sourceId: string;
  expiresAt: number;
  selected: Selection;
  items: RawItem[];
  warnings: string[];
  plan: SyncPlan;
};
const previews = new Map<string, Preview>();
const pendingPreviews = new Map<string, Promise<Preview>>();

export function clearAllEventsPreviewsForTests() {
  previews.clear();
  pendingPreviews.clear();
}

function planOptions(
  ctx: ProviderContext,
  options: SyncOptions,
  defaults?: Pick<Selection, "startDate" | "endDate">,
): Selection {
  const today = localDay(new Date(), ctx.scope.timezone);
  const startDate = options.startDate || defaults?.startDate || today;
  const endDate =
    options.endDate || defaults?.endDate || addDays(startDate, 90);
  if (startDate < today)
    throw new Error(
      "AllEvents: начало диапазона не может быть раньше сегодняшнего дня.",
    );
  if (endDate < startDate)
    throw new Error("AllEvents: конец диапазона раньше начала.");
  if (endDate > addDays(startDate, 365))
    throw new Error("AllEvents: один запуск ограничен диапазоном в 365 дней.");
  const requested = options.categories?.length
    ? [...new Set(options.categories.map((c) => c.toLowerCase()))]
    : ["all"];
  if (requested.some((category) => !categoryValues.has(category as never)))
    throw new Error("AllEvents: выбрана неподдерживаемая категория.");
  const categories = requested.includes("all") ? ["all"] : requested;
  return { startDate, endDate, categories };
}

function selectionKey(selected: Selection) {
  return JSON.stringify({
    ...selected,
    categories: [...selected.categories].sort(),
  });
}
function previewRequestKey(ctx: ProviderContext, options: SyncOptions) {
  return JSON.stringify({
    sourceId: ctx.source.id,
    keyword: ctx.source.keyword,
    startDate: options.startDate || "",
    endDate: options.endDate || "",
    categories: [...(options.categories || [])].sort(),
  });
}
function validateSource(ctx: ProviderContext) {
  const url = new URL(ctx.source.url);
  if (
    url.protocol !== "https:" ||
    !["allevents.in", "www.allevents.in"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !["/belgrade/all", "/belgrade/all/"].includes(url.pathname) ||
    url.search
  )
    throw new Error("AllEvents: укажите https://allevents.in/belgrade/all");
  if (ctx.scope.id !== "belgrade")
    throw new Error("AllEvents: адаптер поддерживает только Белград.");
}
async function randomPause() {
  if (process.env.NODE_ENV === "test") return;
  await new Promise((resolve) =>
    setTimeout(resolve, 2000 + Math.floor(Math.random() * 1001)),
  );
}
function cookieFrom(headers: Headers) {
  const values =
    typeof (headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [headers.get("set-cookie") || ""];
  return values
    .map((value) => value.split(";", 1)[0])
    .filter((value) => /^[^=\s]+=[^;]*$/.test(value))
    .join("; ");
}
function lastEpochAssignment(html: string, field: string) {
  const matches = [
    ...html.matchAll(
      new RegExp(`_this\\.${field}\\s*=\\s*(\\d{9,12})\\s*;`, "g"),
    ),
  ];
  return matches.length ? Number(matches.at(-1)![1]) : null;
}
function embeddedEvents(html: string) {
  const assignments = [...html.matchAll(/_this\.events_data\s*=\s*\[/g)];
  const assignment = assignments.at(-1);
  const start =
    assignment?.index == null ? -1 : html.indexOf("[", assignment.index);
  if (start < 0) return [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) {
      try {
        const parsed = JSON.parse(html.slice(start, index + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new Error(
          "AllEvents изменил формат первой страницы: embedded JSON не читается.",
        );
      }
    }
  }
  throw new Error(
    "AllEvents изменил формат первой страницы: список событий не завершён.",
  );
}
async function readBody(response: Response) {
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes)
    throw new Error("AllEvents вернул ответ больше 20 МБ. Сузьте диапазон.");
  return body.toString("utf8");
}
function requester() {
  let requested = false;
  let requestCount = 0;
  const request = async (url: string, init: RequestInit = {}) => {
    const statuses: number[] = [];
    for (;;) {
      if (requested) await randomPause();
      requested = true;
      await validateRemote(url);
      requestCount++;
      const response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(45000),
        headers: {
          "User-Agent": "ActivityChecker/0.1 (personal local activity catalog)",
          ...init.headers,
        },
      });
      if (blockStatuses.has(response.status)) {
        statuses.push(response.status);
        await response.body?.cancel();
        if (statuses.length >= 3)
          throw new Error(
            `AllEvents остановлен после трёх ответов блокировки (${statuses.join(", ")}). Источник помечен ошибкой; повторите вручную позже.`,
          );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`AllEvents ответил HTTP ${response.status}.`);
      }
      return response;
    }
  };
  return { request, requestCount: () => requestCount };
}
async function connect(ctx: ProviderContext) {
  validateSource(ctx);
  const client = requester();
  const { request } = client;
  const response = await request(`${origin}/belgrade/all`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const cookie = cookieFrom(response.headers);
  const html = await readBody(response);
  const match = html.match(
    /window\.__cst\s*=\s*(["'])([A-Za-z0-9._-]{20,1000})\1/,
  );
  if (!match || !cookie)
    throw new Error(
      "AllEvents изменил сессию страницы: не найдены client-state или cookie.",
    );
  const embedded = embeddedEvents(html);
  const startEpoch = lastEpochAssignment(html, "search_sdate");
  const endEpoch = lastEpochAssignment(html, "search_edate");
  const pageRange =
    startEpoch && endEpoch
      ? {
          startDate: new Date(startEpoch * 1000).toISOString().slice(0, 10),
          endDate: new Date(endEpoch * 1000).toISOString().slice(0, 10),
        }
      : undefined;
  return {
    request,
    requestCount: client.requestCount,
    cookie,
    token: match[2],
    embedded,
    embeddedCount: embedded.length,
    pageRange,
    pageEpochRange:
      startEpoch && endEpoch ? { startEpoch, endEpoch } : undefined,
  };
}
function canonicalCategory(tags: string[]) {
  if (tags.some((tag) => /music|concert|party|edm|dance/.test(tag)))
    return "Музыка";
  if (tags.some((tag) => /art|theatre|performance|comedy|exhibition/.test(tag)))
    return "Искусство";
  if (tags.some((tag) => /sport|fitness|running|yoga/.test(tag)))
    return "Спорт";
  if (tags.some((tag) => /food|drink|wine|beer/.test(tag)))
    return "Еда и напитки";
  if (
    tags.some((tag) =>
      /education|business|technology|workshop|conference/.test(tag),
    )
  )
    return "Обучение";
  if (tags.some((tag) => /game|gaming/.test(tag))) return "Игры";
  if (tags.some((tag) => /movie|cinema|film/.test(tag))) return "Кино";
  if (tags.some((tag) => /meetup|network|community|nonprofit/.test(tag)))
    return "Общение";
  return "Другое";
}
export function parseAllEventsEvent(
  value: unknown,
  ctx: ProviderContext,
): RawItem {
  const event = eventSchema.parse(value);
  const title = text(event.eventname_raw || event.eventname);
  if (!title) throw new Error("AllEvents: у события отсутствует название.");
  const custom = event.custom_params || {};
  const tags = [
    ...strings(event.categories),
    ...strings(event.tags),
    ...strings(event.formats),
    ...strings(custom.merged_lookup),
    ...strings(custom.gemma_categories),
  ]
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 50);
  const eventUrl = safeUrl(event.event_url || event.share_url, "allevents.in");
  if (!eventUrl) throw new Error("AllEvents: некорректная ссылка события.");
  const organizer = text(event.organizer?.name);
  const description = [
    text(event.short_description),
    organizer && `Организатор: ${organizer}`,
  ]
    .filter(Boolean)
    .join("\n");
  const latitude = Number(event.venue?.latitude);
  const longitude = Number(event.venue?.longitude);
  const normalized = entitySchema.parse({
    type: "Event",
    title,
    description,
    country: "RS",
    city: "Belgrade",
    category: canonicalCategory(tags),
    rawCategory: tags.join(", "),
    tags,
    startAt: new Date(event.start_time * 1000).toISOString(),
    endAt:
      event.end_time && event.end_time >= event.start_time
        ? new Date(event.end_time * 1000).toISOString()
        : "",
    venue: text(event.location),
    address: text(event.venue?.full_address || event.venue?.street),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    url: eventUrl,
    website: safeUrl(event.tickets?.ticket_url),
    imageUrl: safeUrl(event.banner_url || event.thumb_url_large),
    externalId: event.event_id,
    knownIds: { allevents: event.event_id },
  });
  return {
    externalId: event.event_id,
    url: eventUrl,
    rawText: [
      title,
      normalized.startAt,
      normalized.venue,
      normalized.address,
      description,
    ]
      .filter(Boolean)
      .join("\n"),
    payload: { original: value, normalized },
  };
}

type Session = Awaited<ReturnType<typeof connect>>;
type ApiPage = { values: unknown[]; count: number; fingerprint: string };

async function fetchApiPage(
  session: Session,
  ctx: ProviderContext,
  selected: Selection,
  page: number,
  rows: number,
  reuseHtmlRange = false,
): Promise<ApiPage> {
  const response = await session.request(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: session.cookie,
      Referer: `${origin}/belgrade/all`,
      "X-Client-State": session.token,
    },
    body: JSON.stringify({
      venue: 0,
      page,
      rows,
      tag_type: "",
      sdate:
        reuseHtmlRange && session.pageEpochRange
          ? session.pageEpochRange.startEpoch
          : epochAtStart(selected.startDate, ctx.scope.timezone),
      edate:
        reuseHtmlRange && session.pageEpochRange
          ? session.pageEpochRange.endEpoch
          : epochAtStart(addDays(selected.endDate, 1), ctx.scope.timezone) - 1,
      city: "belgrade",
      keywords: ctx.source.keyword || "0",
      category: selected.categories,
      formats: 0,
      sort_by_score_only: true,
    }),
  });
  const raw = await readBody(response);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("AllEvents вернул невалидный JSON.");
  }
  const parsed = z
    .object({
      item: z.array(z.unknown()),
      count: z.coerce.number().int().nonnegative(),
    })
    .passthrough()
    .safeParse(data);
  if (!parsed.success)
    throw new Error("AllEvents изменил формат списка событий.");
  return {
    values: parsed.data.item,
    count: parsed.data.count,
    fingerprint: parsed.data.item
      .map((item) =>
        item && typeof item === "object" && "event_id" in item
          ? String((item as { event_id: unknown }).event_id)
          : "?",
      )
      .join("|"),
  };
}

async function preparePreview(
  ctx: ProviderContext,
  options: SyncOptions,
): Promise<Preview> {
  const stamp = Date.now();
  for (const [id, preview] of previews)
    if (preview.expiresAt <= stamp) previews.delete(id);

  const session = await connect(ctx);
  const selected = planOptions(ctx, options, session.pageRange);
  const canReuseEmbedded =
    !!session.pageRange &&
    session.pageRange.startDate === selected.startDate &&
    session.pageRange.endDate === selected.endDate &&
    selected.categories.length === 1 &&
    selected.categories[0] === "all" &&
    !ctx.source.keyword.trim() &&
    session.embedded.length > 0;
  const items = new Map<string, RawItem>();
  const fingerprints = new Set<string>();
  const warnings: string[] = [];
  let invalid = 0;
  let repeated = 0;
  let exactPages = 0;

  const collect = (values: unknown[]) => {
    if (values.length) exactPages++;
    for (const value of values) {
      try {
        const item = parseAllEventsEvent(value, ctx);
        if (items.has(item.externalId)) repeated++;
        items.set(item.externalId, item);
      } catch {
        invalid++;
      }
    }
  };
  const assertNewPage = (page: ApiPage) => {
    if (page.fingerprint && fingerprints.has(page.fingerprint))
      throw new Error(
        "AllEvents повторил страницу; точное число страниц определить нельзя. Повторите позже с более узким диапазоном.",
      );
    if (page.fingerprint) fingerprints.add(page.fingerprint);
  };

  if (canReuseEmbedded) {
    collect(session.embedded);
    let finished = false;
    for (let page = 2; page <= ALLEVENTS_MAX_PAGES; page++) {
      const rows = page === 2 ? embeddedContinuationRows : websitePageRows;
      const result = await fetchApiPage(
        session,
        ctx,
        selected,
        page,
        rows,
        true,
      );
      assertNewPage(result);
      collect(result.values);
      if (result.count < websitePageRows) {
        finished = true;
        break;
      }
    }
    if (!finished)
      throw new Error(
        `AllEvents: после ${ALLEVENTS_MAX_PAGES} страниц конец списка не найден. Сузьте даты или категории — без этого точное число страниц недоступно.`,
      );
  } else {
    let finished = false;
    for (let page = 1; page <= ALLEVENTS_MAX_PAGES; page++) {
      const result = await fetchApiPage(
        session,
        ctx,
        selected,
        page,
        ALLEVENTS_ROWS,
      );
      assertNewPage(result);
      collect(result.values);
      if (result.count < ALLEVENTS_ROWS) {
        finished = true;
        break;
      }
    }
    if (!finished)
      throw new Error(
        `AllEvents: после ${ALLEVENTS_MAX_PAGES} страниц конец списка не найден. Сузьте даты или категории — без этого точное число страниц недоступно.`,
      );
  }

  if (invalid)
    warnings.push(
      `Пропущены карточки с неподдерживаемым форматом: ${invalid}.`,
    );
  if (repeated)
    warnings.push(
      `Убраны повторы карточек между страницами: ${repeated}. В базу попадёт по одной записи на event_id.`,
    );
  if (invalid && !items.size)
    throw new Error("AllEvents: ни одну карточку не удалось разобрать.");

  const id = randomUUID();
  const expiresAt = Date.now() + ALLEVENTS_PREVIEW_TTL_MS;
  const requestCount = session.requestCount();
  const plan: SyncPlan = {
    sourceId: ctx.source.id,
    providerId: "allevents",
    title: "Подтвердите запись AllEvents",
    summary:
      "Точный предварительный обход завершён. Карточки временно сохранены в памяти сервера; подтверждение запишет их в SQLite без новых запросов к AllEvents.",
    requiresConfirmation: true,
    expectedRequests: requestCount,
    minimumRequests: requestCount,
    maximumRequests: requestCount,
    rowsPerRequest: ALLEVENTS_ROWS,
    startDate: selected.startDate,
    endDate: selected.endDate,
    categories: selected.categories,
    categoryOptions: [...allEventsCategories],
    previewId: id,
    previewExpiresAt: new Date(expiresAt).toISOString(),
    exactPages,
    previewRequests: requestCount,
    requestsAfterConfirmation: 0,
    firstPageReused: canReuseEmbedded,
    parameters: [
      { label: "Страниц с данными", value: `${exactPages} · точно` },
      {
        label: "Карточек после event_id-дедупликации",
        value: String(items.size),
      },
      {
        label: "Запросов предпросмотра",
        value: `${requestCount} · уже выполнены`,
      },
      { label: "Запросов после подтверждения", value: "0" },
      {
        label: "Первая страница",
        value: canReuseEmbedded
          ? "взята из HTML /belgrade/all"
          : "получена API для выбранных фильтров",
      },
      { label: "Пауза", value: "случайно 2–3 секунды" },
      { label: "Кэш предпросмотра", value: "10 минут" },
      { label: "Автозапуск", value: "выключен" },
    ],
    warnings: [
      "AllEvents не отдаёт total в HTML: точное число получено чтением пагинации до последней страницы.",
      "Изменение дат или категорий требует нового точного предпросмотра.",
      "При трёх последовательных сигналах блокировки обход остановится с уведомлением.",
      ...warnings,
    ],
  };
  const preview: Preview = {
    id,
    sourceId: ctx.source.id,
    expiresAt,
    selected,
    items: [...items.values()],
    warnings,
    plan,
  };
  previews.set(id, preview);
  return preview;
}

async function exactPreview(ctx: ProviderContext, options: SyncOptions) {
  const key = previewRequestKey(ctx, options);
  const current = pendingPreviews.get(key);
  if (current) return current;
  const pending = preparePreview(ctx, options);
  pendingPreviews.set(key, pending);
  try {
    return await pending;
  } finally {
    if (pendingPreviews.get(key) === pending) pendingPreviews.delete(key);
  }
}

export default defineProvider(
  {
    id: "allevents",
    name: "AllEvents · Belgrade",
    group: "API Агрегаторы",
    providerType: "Website/Aggregator",
    supportedEntityTypes: ["Event"],
    supportedScopes: ["belgrade"],
    implemented: true,
    mode: "ingestion",
    configFields: ["url", "keyword"],
    defaultUrl: `${origin}/belgrade/all`,
    credentials: [],
    manualSyncOnly: true,
    requiresSyncConfirmation: true,
    description: "Предстоящие события Белграда с фильтром дат и категорий.",
    docs: [
      { label: "Все события Белграда", url: `${origin}/belgrade/all` },
      { label: "Условия использования", url: `${origin}/conditions` },
    ],
    steps: [
      "Единая кнопка блока API Агрегаторы сначала обновляет обычные источники, затем открывает отдельный план AllEvents.",
      "Перед каждым запуском проверьте диапазон дат, категории и оценку числа запросов в модальном окне.",
      "Карточки сохраняются в provenance и в отдельной таблице allevents_raw_events; затем нормализуются в события.",
    ],
    limitations:
      "Недокументированный веб-интерфейс. Между запросами выдерживается случайная пауза 2–3 секунды; после трёх 401/403/429/503 обход останавливается. Условия AllEvents запрещают scraping без разрешения — используйте только осознанно и низкочастотно.",
  },
  {
    async planSync(ctx, options) {
      return (await exactPreview(ctx, options)).plan;
    },
    async testConnection(ctx) {
      const session = await connect(ctx);
      return `AllEvents доступен: получена веб-сессия и client-state. Карточек на первой HTML-странице: ${session.embeddedCount}. Запросы пагинации не выполнялись.`;
    },
    async sync(ctx, options = { confirmed: false }) {
      const preview = options.previewId
        ? previews.get(options.previewId)
        : undefined;
      if (!preview || preview.sourceId !== ctx.source.id)
        throw new Error(
          "AllEvents: сначала откройте Sync и дождитесь точного предпросмотра страниц.",
        );
      if (preview.expiresAt <= Date.now()) {
        previews.delete(preview.id);
        throw new Error(
          "AllEvents: предпросмотр устарел. Откройте Sync и рассчитайте страницы снова.",
        );
      }
      const selected = planOptions(ctx, {
        ...options,
        startDate: options.startDate || preview.selected.startDate,
        endDate: options.endDate || preview.selected.endDate,
        categories: options.categories || preview.selected.categories,
      });
      if (selectionKey(selected) !== selectionKey(preview.selected))
        throw new Error(
          "AllEvents: фильтры изменились после предпросмотра. Пересчитайте точное число страниц.",
        );
      previews.delete(preview.id);
      return { items: preview.items, warnings: preview.warnings };
    },
    normalize(item) {
      return entitySchema.parse(
        (item.payload as { normalized: unknown }).normalized,
      );
    },
  },
);

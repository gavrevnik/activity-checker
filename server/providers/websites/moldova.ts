import {
  catalogs,
  isChisinau,
  collectEvents,
  type Catalog,
  type EventPage,
} from "@personal-radar/connectors/moldova-events";
import { entitySchema } from "../../../shared/model.js";
import { parseCalendarInput, localDay } from "../../../shared/dates.js";
import { knowledgeVenueCities } from "../../recommendation-sources.js";
import { crawlStateStore } from "./moldova-crawl-state.js";
import { browserCall } from "../../browser-rpc.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";

function category(value: string) {
  if (/concert|music|концерт/i.test(value)) return "Музыка";
  if (/sport|run|спорт/i.test(value)) return "Спорт";
  if (/theatr|театр|teatru|exhibit|festival/i.test(value)) return "Искусство";
  if (/workshop|training|conference/i.test(value)) return "Обучение";
  return "Другое";
}
export function moldovaItem(
  id: Catalog,
  event: EventPage,
  ctx: ProviderContext,
): RawItem {
  const independentSession = id === "iticket-md" && event.id.includes("@");
  const externalId = independentSession ? `session:${event.id}` : event.id;
  const instant = (value: string) => {
    if (!value) return "";
    if (/T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      return new Date(value).toISOString();
    return parseCalendarInput(
      value.slice(0, 10),
      value.includes("T") ? value.slice(11, 16) : "",
      ctx.scope.timezone,
    );
  };
  const normalized = entitySchema.parse({
    type: "Event",
    title: event.title,
    description: event.description,
    country: "MD",
    city: isChisinau(event.city) ? "Chisinau" : event.city || "",
    category: category(event.category),
    rawCategory: event.category,
    tags: event.category
      ? event.category.split(/[,;|]/).map((value) => value.trim()).filter(Boolean).map((value) => value.slice(0, 80)).slice(0, 50)
      : [],
    startAt: instant(event.start),
    endAt: instant(event.end),
    venue: event.venue,
    address: event.address,
    url: event.url,
    imageUrl: event.image,
    price: event.price,
    externalId,
    knownIds: { [independentSession ? "iticket_session" : id.replaceAll("-", "_")]: event.id },
  });
  return {
    externalId,
    url: event.url,
    rawText: [
      event.title,
      event.description,
      event.start,
      event.end,
      event.venue,
      event.price,
    ]
      .filter(Boolean)
      .join("\n"),
    payload: { original: event, normalized },
  };
}
function checkContext(id: Catalog, ctx: ProviderContext) {
  if (
    ctx.scope.id !== "chisinau" ||
    ctx.source.url.replace(/\/$/, "") !== catalogs[id].url.replace(/\/$/, "")
  )
    throw Error(
      `${catalogs[id].name}: выберите Кишинёв и URL ${catalogs[id].url}.`,
    );
}
export const moldovaProviders = (Object.keys(catalogs) as Catalog[]).map((id) =>
  defineProvider(
    {
      id,
      name: catalogs[id].name,
      group: "API Агрегаторы",
      providerType: "Website/Aggregator",
      supportedEntityTypes: ["Event"],
      supportedScopes: ["chisinau"],
      implemented: true,
      mode: "ingestion",
      configFields: ["url"],
      defaultUrl: catalogs[id].url,
      credentials: [],
      manualSyncOnly: [
        "afisha-md",
        "sporter-md",
        "moldova-travel",
        "frc-chisinau",
      ].includes(id),
      description:
        id === "afisha-md"
          ? "Anonymous renderer, полный sitemap и проверка основной JSON-LD карточки."
          : "Публичные мероприятия Кишинёва: список и подробные страницы без ключей.",
      docs: [{ label: "Открыть источник", url: catalogs[id].url }],
      steps: [
        "Выберите Кишинёв; ключ и регистрация не требуются.",
        "Sync читает один поток для текущей и следующей недели. AI-отбор использует прежний профиль и реакции; язык сайта не доказывает язык события.",
        "Ограничения покрытия возвращаются в предупреждениях каждого запуска; неполный список дополните веб-поиском.",
      ],
      limitations:
        id === "afisha-md"
          ? "Требуется Agent Stack anonymous renderer. Список подтверждается рендером, страницы перечисляются через публичный sitemap; детали читаются из HTML с renderer fallback. Без внутреннего /api, логина и обхода CAPTCHA."
          : "По умолчанию 24 детали за вызов (maxItems до 100); продолжение сохраняется между запусками с теми же датами. iTicket: публичный Livewire loadMore и отдельные подтверждённые сеансы. Afisha Mira: REST city=205, дата публикации не дата события. Sporter: публичный каталог и проверенный город площадки. Moldova Travel: только явный год; FRC: только опубликованные встречи. coverage отражает обход, unresolved — карточки с неподтверждёнными фактами; warnings раскрывают пропуски.",
    },
    {
      async testConnection(ctx) {
        checkContext(id, ctx);
        const result = await collectEvents(id, {
          maxDetails: 1,
          browser: browserCall,
        });
        return `${catalogs[id].name}: транспорт и разбор проверены, карточек ${result.events.length}, запросов ${result.requests}. ${result.warnings.join(" ")}`;
      },
      async sync(ctx, options) {
        checkContext(id, ctx);
        const from =
          options?.startDate || localDay(new Date(), ctx.scope.timezone);
        const cache = crawlStateStore(
          ctx.source.id,
          id,
          from,
          options?.endDate,
        );
        const result = await collectEvents(id, {
          venueCities: knowledgeVenueCities("MD"),
          state: await cache.load(),
          checkpoint: cache.save,
          maxDetails: Math.min(100, options?.maxItems || 24),
          from: options?.startDate || localDay(new Date(), ctx.scope.timezone),
          to: options?.endDate,
          browser: browserCall,
        });
        return {
          items: result.events.map((e) => moldovaItem(id, e, ctx)),
          warnings: result.warnings,
          coverage: result.coverage,
        };
      },
      normalize(item) {
        return entitySchema.parse(
          (item.payload as { normalized: unknown }).normalized,
        );
      },
    },
  ),
);

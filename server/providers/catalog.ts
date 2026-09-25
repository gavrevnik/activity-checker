import type { ProviderInfo } from "../../shared/model.js";
import { planned } from "./types.js";
type Entry = Pick<
  ProviderInfo,
  | "id"
  | "name"
  | "group"
  | "providerType"
  | "description"
  | "credentials"
  | "docs"
  | "steps"
  | "limitations"
> &
  Partial<ProviderInfo>;
const definitions: Entry[] = [
  {
    id: "telegram",
    registration: { service: "Telegram", url: "https://my.telegram.org/" },
    name: "Telegram · MTProto",
    group: "Социальные сети",
    providerType: "MTProto",
    description: "Мониторинг известных публичных каналов и групп.",
    supportedEntityTypes: ["Event", "Community"],
    credentials: [
      { key: "TELEGRAM_API_ID", label: "API ID" },
      { key: "TELEGRAM_API_HASH", label: "API hash" },
    ],
    docs: [
      { label: "Создать приложение", url: "https://my.telegram.org" },
      {
        label: "API ID",
        url: "https://core.telegram.org/api/obtaining_api_id",
      },
      { label: "Telethon", url: "https://docs.telethon.dev/" },
    ],
    steps: [
      "Откройте my.telegram.org → API development tools, создайте приложение.",
      "Добавьте TELEGRAM_API_ID и TELEGRAM_API_HASH в .env.local.",
      "Добавьте URL публичного канала как источник.",
      "Следующий этап разработки: отдельный Telethon worker, локальная авторизация телефона и файл сессии вне SQLite.",
    ],
    limitations:
      "Заготовка. Ключей недостаточно: MTProto требует пользовательской сессии и отдельного ingestion adapter.",
  },
  {
    id: "tgstat",
    registration: { service: "TGStat", url: "https://tgstat.ru/" },
    name: "TGStat",
    group: "Социальные сети",
    providerType: "Discovery API",
    mode: "discovery",
    supportedEntityTypes: ["Community"],
    description: "Поиск новых каналов: сначала RU, затем expat и местные.",
    credentials: [{ key: "TGSTAT_TOKEN", label: "API token" }],
    docs: [{ label: "Документация", url: "https://api.tgstat.ru/docs/ru/" }],
    steps: [
      "Получите API token в TGStat; проверьте доступный тариф и методы поиска.",
      "Добавьте TGSTAT_TOKEN в .env.local.",
      "Следующий этап: adapter discovery, сохраняющий результаты в SourceCandidate.",
    ],
    limitations:
      "Опциональный внешний сервис. Тариф и доступные методы зависят от аккаунта; адаптер пока не реализован.",
  },
  {
    id: "instagram",
    registration: { service: "Apify", url: "https://console.apify.com/" },
    name: "Instagram · Apify",
    group: "Социальные сети",
    providerType: "Scraper",
    description: "Выбранные публичные профили площадок и организаторов.",
    credentials: [{ key: "APIFY_TOKEN", label: "Personal API token" }],
    docs: [
      {
        label: "Profile scraper",
        url: "https://apify.com/apify/instagram-api-scraper",
      },
      {
        label: "Search scraper",
        url: "https://apify.com/apify/instagram-search-scraper",
      },
    ],
    steps: [
      "В Apify создайте API token и проверьте условия нужного Actor.",
      "Добавьте APIFY_TOKEN в .env.local и URL Instagram-профиля в источник.",
      "Следующий этап: запуск Actor, чтение dataset и нормализация публикаций.",
    ],
    limitations:
      "Заготовка. Запуски Actor могут быть платными. Официальный Meta API не рассматривается как универсальный публичный поиск.",
  },
  {
    id: "facebook-scrapecreators",
    registration: {
      service: "ScrapeCreators",
      url: "https://scrapecreators.com/",
    },
    name: "Facebook · ScrapeCreators",
    group: "Социальные сети",
    providerType: "Scraper",
    description: "Городской поиск событий или события публичной страницы.",
    credentials: [{ key: "SCRAPECREATORS_API_KEY", label: "API key" }],
    docs: [
      {
        label: "События города",
        url: "https://docs.scrapecreators.com/v1/facebook/events/",
      },
      {
        label: "Поиск",
        url: "https://docs.scrapecreators.com/v1/facebook/events/search/",
      },
      {
        label: "Публичная страница",
        url: "https://docs.scrapecreators.com/v1/facebook/profile/events/",
      },
    ],
    steps: [
      "Получите ключ ScrapeCreators и проверьте баланс.",
      "Добавьте SCRAPECREATORS_API_KEY в .env.local.",
      "Сохраните Facebook page URL или страницу city events.",
      "Следующий этап: adapter для выбранного метода и его параметров.",
    ],
    limitations:
      "Заготовка; запросы могут расходовать платные кредиты. City discovery и page events требуют разных параметров.",
  },
  {
    id: "facebook-apify",
    registration: { service: "Apify", url: "https://console.apify.com/" },
    name: "Facebook Events · Apify",
    group: "Социальные сети",
    providerType: "Scraper",
    description: "События из выбранных Facebook URLs.",
    credentials: [{ key: "APIFY_TOKEN", label: "Personal API token" }],
    docs: [
      {
        label: "Events scraper",
        url: "https://apify.com/apify/facebook-events-scraper",
      },
    ],
    steps: [
      "Проверьте условия Facebook Events Actor в Apify.",
      "Добавьте APIFY_TOKEN в .env.local и URL страницы.",
      "Следующий этап: Actor runner, dataset adapter и обработка ошибок.",
    ],
    limitations: "Заготовка. Доступность данных и стоимость определяет Actor.",
  },
  {
    id: "meetup",
    registration: { service: "Meetup", url: "https://www.meetup.com/" },
    name: "Meetup",
    group: "Международные",
    providerType: "GraphQL",
    supportedEntityTypes: ["Event", "Community"],
    description: "Сообщества, хобби, expat и профессиональные встречи.",
    credentials: [{ key: "MEETUP_ACCESS_TOKEN", label: "OAuth access token" }],
    docs: [
      { label: "GraphQL guide", url: "https://www.meetup.com/graphql/guide/" },
    ],
    steps: [
      "Проверьте требования Meetup к API-доступу для своего аккаунта и приложения.",
      "Настройте OAuth по документации Meetup.",
      "Следующий этап: OAuth refresh flow и GraphQL adapter.",
    ],
    limitations:
      "Заготовка. Доступ API и возможности поиска зависят от одобрения и плана Meetup.",
  },
  {
    id: "eventbrite",
    registration: {
      service: "Eventbrite",
      url: "https://www.eventbrite.com/platform/",
    },
    name: "Eventbrite",
    group: "Международные",
    providerType: "API",
    description: "События доступных вашему аккаунту организаторов.",
    credentials: [{ key: "EVENTBRITE_TOKEN", label: "OAuth token" }],
    docs: [
      {
        label: "OAuth",
        url: "https://www.eventbrite.com/platform/docs/app-oauth-flow",
      },
    ],
    steps: [
      "Создайте приложение Eventbrite и проверьте область API-доступа.",
      "Добавьте EVENTBRITE_TOKEN в .env.local.",
      "Следующий этап: adapter конкретной организации; глобальный discovery не предполагается.",
    ],
    limitations:
      "Заготовка. OAuth не гарантирует произвольный публичный поиск мероприятий.",
  },
  {
    id: "predicthq",
    registration: {
      service: "PredictHQ",
      url: "https://control.predicthq.com/",
    },
    name: "PredictHQ",
    group: "Международные",
    providerType: "API",
    description: "Опциональные международные данные о событиях.",
    credentials: [{ key: "PREDICTHQ_TOKEN", label: "Access token" }],
    docs: [{ label: "Developer docs", url: "https://docs.predicthq.com/" }],
    steps: [
      "Проверьте план PredictHQ и доступ к нужной географии.",
      "Добавьте PREDICTHQ_TOKEN в .env.local.",
      "Следующий этап: events adapter и mapping категорий.",
    ],
    limitations:
      "Заготовка. Платный или ограниченный план; не требуется для основной работы.",
  },
  {
    id: "google-places",
    registration: {
      service: "Google Cloud",
      url: "https://console.cloud.google.com/",
    },
    name: "Google Places",
    group: "Места",
    providerType: "Enrichment API",
    mode: "enrichment",
    supportedEntityTypes: ["Place"],
    description: "Рейтинг, число отзывов, телефон и часы работы.",
    credentials: [{ key: "GOOGLE_PLACES_API_KEY", label: "Places API key" }],
    docs: [
      {
        label: "Получить ключ",
        url: "https://developers.google.com/maps/documentation/places/web-service/get-api-key",
      },
    ],
    steps: [
      "В Google Cloud включите Places API и billing, ограничьте ключ.",
      "Добавьте GOOGLE_PLACES_API_KEY в .env.local.",
      "Следующий этап: enrichment adapter с FieldMask и соблюдением правил хранения Google.",
    ],
    limitations:
      "Заготовка. Google не используется как постоянная основная база; условия кеширования нужно учитывать при реализации.",
  },
  {
    id: "foursquare",
    registration: {
      service: "Foursquare",
      url: "https://foursquare.com/developers/",
    },
    name: "Foursquare Places",
    group: "Места",
    providerType: "Enrichment API",
    mode: "enrichment",
    supportedEntityTypes: ["Place"],
    description: "Дополнительные сведения о местах.",
    credentials: [{ key: "FOURSQUARE_API_KEY", label: "API key" }],
    docs: [
      {
        label: "Places API",
        url: "https://docs.foursquare.com/data-products/docs/places-api",
      },
    ],
    steps: [
      "Создайте проект Foursquare и проверьте актуальный Places API и план.",
      "Добавьте FOURSQUARE_API_KEY в .env.local.",
      "Следующий этап: enrichment adapter для выбранной версии API.",
    ],
    limitations:
      "Заготовка. Условия доступа и хранения определяются провайдером.",
  },
];
export const catalog = definitions.map((d) =>
  planned({
    supportedEntityTypes: ["Event"],
    supportedScopes: ["*"],
    mode: "ingestion",
    ...d,
  }),
);

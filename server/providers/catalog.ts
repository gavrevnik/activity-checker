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
    id: "instagram",
    registration: { service: "Apify", url: "https://console.apify.com/" },
    name: "Instagram · Apify",
    group: "MCP",
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
    name: "Facebook · ScrapeCreators",
    group: "MCP",
    providerType: "Legacy",
    description: "Скрытая legacy-запись для совместимости старых SQLite-баз.",
    credentials: [],
    docs: [],
    steps: [],
    limitations:
      "Источник удалён из интерфейса; Facebook-ссылки направляются в рабочий Facebook Events · Apify.",
    hiddenFromSources: true,
  },
  {
    id: "facebook-apify",
    registration: { service: "Apify", url: "https://console.apify.com/" },
    name: "Facebook Events · Apify",
    group: "MCP",
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
    name: "Meetup",
    group: "LLM Web",
    providerType: "LLM Web",
    supportedEntityTypes: ["Event", "Community"],
    description: "LLM Web · Поиск публичных страниц событий и сообществ.",
    credentials: [],
    docs: [{ label: "Открыть Meetup", url: "https://www.meetup.com/" }],
    steps: [],
    webSearchLlm: true,
    limitations:
      "Поиск выполняется через индексированные публичные страницы Meetup, без локальной API-интеграции.",
  },
  {
    id: "eventbrite",
    name: "Eventbrite",
    group: "LLM Web",
    providerType: "LLM Web",
    description: "LLM Web · Поиск индексированных публичных страниц событий.",
    credentials: [],
    docs: [{ label: "Открыть Eventbrite", url: "https://www.eventbrite.com/" }],
    steps: [],
    webSearchLlm: true,
    limitations:
      "Поиск выполняется через индексированные публичные страницы Eventbrite, без локальной API-интеграции.",
  },
  {
    id: "belgrade-beat-web",
    name: "Belgrade Beat · LLM Web",
    group: "LLM Web",
    providerType: "LLM Web",
    supportedEntityTypes: ["Event", "Place"],
    description:
      "LLM Web · Поиск дополнительной информации на публичных страницах Belgrade Beat.",
    credentials: [],
    docs: [
      { label: "Открыть Belgrade Beat", url: "https://belgrade-beat.com/" },
    ],
    steps: [],
    webSearchLlm: true,
    limitations:
      "Используется для дополнительного Web Search; недельные события отдельно собирает API-агрегатор Belgrade Beat.",
  },
  {
    id: "predicthq",
    registration: {
      service: "PredictHQ",
      url: "https://control.predicthq.com/",
    },
    name: "PredictHQ",
    group: "LLM Web",
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
    hiddenFromSources: true,
  },
  {
    id: "foursquare",
    registration: {
      service: "Foursquare",
      url: "https://foursquare.com/developers/",
    },
    name: "Foursquare Places",
    group: "MCP",
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
const implementedElsewhere = new Set([
  "instagram",
  "facebook-apify",
  "google-places",
  "foursquare",
]);
export const catalog = definitions
  .filter((d) => !implementedElsewhere.has(d.id))
  .map((d) =>
    planned({
      supportedEntityTypes: ["Event"],
      supportedScopes: ["*"],
      mode: "ingestion",
      configFields: [],
      ...d,
    }),
  );

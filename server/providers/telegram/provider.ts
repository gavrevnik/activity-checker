import {
  entitySchema,
  type NormalizedEntity,
  type SyncOptions,
} from "../../../shared/model.js";
import {
  defineProvider,
  type ProviderContext,
  type RawItem,
} from "../types.js";
import {
  estimatedTelegramRequests,
  executeTelegramBatch,
  telegramOperations,
  telegramQueriesFromText,
  telegramResultSchema,
  telegramStatus,
  type TelegramOperation,
  type TelegramSearchResult,
} from "./client.js";

export const defaultTelegramOperations: TelegramOperation[] = [
  "searchPublicChats",
  "channels.searchPosts",
];

function credentials(ctx: ProviderContext) {
  return {
    apiId: ctx.secrets.TELEGRAM_API_ID || "",
    apiHash: ctx.secrets.TELEGRAM_API_HASH || "",
    pythonPath: ctx.secrets.TELEGRAM_PYTHON,
    sessionPath: ctx.secrets.TELEGRAM_SESSION_PATH,
  };
}

function settings(ctx: ProviderContext, options: SyncOptions) {
  const queries = telegramQueriesFromText(ctx.source.keyword);
  const operations = (
    options.operations?.length ? options.operations : defaultTelegramOperations
  ) as TelegramOperation[];
  const invalid = operations.filter(
    (operation) => !telegramOperations.includes(operation),
  );
  if (invalid.length)
    throw new Error(`Неизвестные Telegram operations: ${invalid.join(", ")}`);
  const queryOperations = operations.filter(
    (operation) => operation !== "channels.getChannelRecommendations",
  );
  if (queryOperations.length && !queries.length)
    throw new Error(
      "Добавьте хотя бы одну поисковую гипотезу в настройки Telegram.",
    );
  const seedChannels = ctx.source.url ? [ctx.source.url] : [];
  const resultsPerQuery = Math.min(options.resultsPerQuery || 10, 50);
  const possible = Math.max(
    resultsPerQuery,
    queries.length * queryOperations.length * resultsPerQuery +
      (operations.includes("channels.getChannelRecommendations")
        ? resultsPerQuery
        : 0),
  );
  const maxItems = Math.min(options.maxItems || 100, possible, 500);
  return {
    queries,
    operations,
    seedChannels,
    resultsPerQuery,
    maxItems,
  };
}

function postTitle(text: string, channelTitle: string) {
  const first = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!first) return `Публикация · ${channelTitle}`;
  return first.length > 180 ? first.slice(0, 177) + "…" : first;
}

export function telegramRawItem(item: TelegramSearchResult): RawItem {
  const channelId = item.channel.id;
  const postId = item.post?.id;
  const externalId = postId
    ? `post:${channelId}:${postId}`
    : `channel:${channelId}`;
  return {
    externalId,
    url: item.post?.url || item.channel.url,
    rawText:
      item.post?.text || `${item.channel.title}\n@${item.channel.username}`,
    payload: { original: item },
    publishedAt: item.post?.date || undefined,
  };
}

export function telegramEntity(
  item: TelegramSearchResult,
  ctx: ProviderContext,
): NormalizedEntity {
  const channel = item.channel;
  if (item.kind === "channel" || !item.post) {
    const participants = item.channel.participantsCount;
    return entitySchema.parse({
      type: "Community",
      title: channel.title || `@${channel.username}`,
      description: [
        `Telegram: @${channel.username}`,
        participants ? `Участники/подписчики: ${participants}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      country: ctx.scope.country,
      city: ctx.scope.city || "",
      category: "Общение",
      rawCategory: channel.broadcast ? "telegram channel" : "telegram group",
      tags: [
        "telegram",
        channel.broadcast ? "channel" : "group",
        ...item.operations,
      ].slice(0, 50),
      url: channel.url,
      memberCount: participants ?? null,
      externalId: `channel:${channel.id}`,
      knownIds: { telegram: channel.id, telegram_username: channel.username },
    });
  }
  const post = item.post;
  return entitySchema.parse({
    type: "Event",
    title: postTitle(post.text, channel.title),
    description: post.text,
    country: ctx.scope.country,
    city: ctx.scope.city || "",
    category: "Другое",
    rawCategory: "telegram public post",
    tags: [
      "telegram",
      "telegram-post",
      "needs-event-review",
      ...item.operations,
    ].slice(0, 50),
    url: post.url,
    externalId: `post:${channel.id}:${post.id}`,
    knownIds: {
      telegram_channel: channel.id,
      telegram_message: post.id,
      telegram_username: channel.username,
    },
  });
}

export function parseTelegramRaw(raw: RawItem) {
  if (!raw.payload || typeof raw.payload !== "object")
    throw new Error("Telegram raw payload отсутствует.");
  const original = (raw.payload as { original?: unknown }).original;
  return telegramResultSchema.parse(original);
}

export const telegram = defineProvider(
  {
    id: "telegram",
    name: "Telegram MTProto · Discovery",
    group: "MCP",
    providerType: "MTProto tool",
    supportedEntityTypes: ["Event", "Community"],
    supportedScopes: ["*"],
    implemented: true,
    mode: "discovery",
    configFields: ["url", "keyword"],
    description:
      "MCP · Batch-поиск публичных Telegram-каналов и постов по ключевым гипотезам.",
    credentials: [
      { key: "TELEGRAM_API_ID", label: "API ID" },
      { key: "TELEGRAM_API_HASH", label: "API hash" },
    ],
    registration: { service: "Telegram", url: "https://my.telegram.org/" },
    manualSyncOnly: true,
    requiresSyncConfirmation: true,
    modelCallable: true,
    mcpServer: "Activity Checker Telegram",
    mcpTools: [
      {
        name: "telegram_status",
        description: "Проверяет Telethon и авторизацию MTProto-сессии.",
      },
      {
        name: "telegram_discovery_batch",
        description:
          "Запускает пакет поисковых гипотез через выбранные методы Telegram.",
      },
      {
        name: "telegram_search_public_chats",
        description: "Ищет публичные каналы и группы по названию или username.",
      },
      {
        name: "telegram_search_posts",
        description: "Ищет публикации в публичных Telegram-каналах.",
      },
      {
        name: "telegram_search_global",
        description:
          "Выполняет глобальный поиск сообщений в публичных каналах и группах.",
      },
      {
        name: "telegram_channel_recommendations",
        description: "Находит похожие каналы по заданным seed-каналам.",
      },
      {
        name: "telegram_sample_channel_posts",
        description:
          "Читает небольшую выборку последних постов для проверки релевантности.",
      },
      {
        name: "telegram_query_history",
        description:
          "Показывает историю и результативность поисковых запросов.",
      },
      {
        name: "telegram_mark_query_relevance",
        description:
          "Записывает оценку релевантности и сохранения результатов поиска.",
      },
    ],
    docs: [
      { label: "MTProto search", url: "https://core.telegram.org/api/search" },
      {
        label: "Telethon sessions",
        url: "https://docs.telethon.dev/en/stable/concepts/sessions.html",
      },
    ],
    steps: [
      "Ключи API ID/API hash хранятся в .env.local; Python-worker устанавливается командой npm run telegram:setup.",
      "Один раз выполните npm run telegram:auth и в терминале введите телефон, код Telegram и 2FA-пароль при наличии.",
      "Добавьте до 30 поисковых гипотез по одной на строку. URL источника можно использовать как seed для рекомендаций.",
      "Перед Sync выберите поиск каналов, публичных постов, глобальный поиск или рекомендации и проверьте число MTProto-запросов.",
    ],
    limitations:
      "Нет тарификации за результат. Запросы идут от пользовательского аккаунта и ограничиваются Telegram FloodWait/Premium; channels.searchPosts может исчерпать бесплатные full-text slots, но tool никогда не разрешает оплату Stars.",
  },
  {
    async testConnection(ctx) {
      const status = await telegramStatus(credentials(ctx));
      if (!status.authorized)
        throw new Error(
          "Ключи доступны, но пользовательская сессия не авторизована. Выполните npm run telegram:auth.",
        );
      const account = status.account;
      return `MTProto-сессия авторизована${account?.username ? ` как @${account.username}` : account?.name ? ` (${account.name})` : ""}. Поисковые запросы не выполнялись.`;
    },
    async planSync(ctx, options) {
      const selected = settings(ctx, options);
      const today = new Date();
      const defaultEndDate = today.toISOString().slice(0, 10);
      const defaultStartDate = new Date(today.getTime() - 90 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const requests = estimatedTelegramRequests({
        queryCount: selected.queries.length,
        operations: selected.operations,
        seedCount: selected.seedChannels.length,
      });
      return {
        sourceId: ctx.source.id,
        providerId: "telegram",
        title: "Параметры Telegram MTProto discovery",
        summary: `${selected.queries.length} гипотез; выбранные операции выполняются последовательно в одной авторизованной сессии.`,
        requiresConfirmation: true,
        expectedRequests: requests,
        minimumRequests: requests,
        maximumRequests: requests,
        startDate: options.startDate || defaultStartDate,
        endDate: options.endDate || defaultEndDate,
        resultsPerQuery: selected.resultsPerQuery,
        limits: { maxItems: selected.maxItems },
        operations: selected.operations,
        operationOptions: [
          {
            value: "searchPublicChats",
            label: "searchPublicChats · каналы/группы по названию",
          },
          {
            value: "channels.searchPosts",
            label: "channels.searchPosts · посты публичных каналов",
          },
          {
            value: "messages.searchGlobal",
            label: "messages.searchGlobal · глобальные сообщения",
          },
          {
            value: "channels.getChannelRecommendations",
            label: "getChannelRecommendations · похожие каналы",
          },
        ],
        parameters: [
          { label: "Гипотезы", value: String(selected.queries.length) },
          { label: "Операции", value: String(selected.operations.length) },
          { label: "На запрос", value: `до ${selected.resultsPerQuery}` },
          {
            label: "Общий hard cap",
            value: `${selected.maxItems} результатов`,
          },
          { label: "Пауза", value: "2.5–3.25 сек. между RPC" },
          { label: "Тарификация", value: "$0/result; Stars запрещены" },
        ],
        warnings: [
          "FloodWait немедленно остановит batch; повторный запуск нужно делать после указанной Telegram паузы.",
          "Посты сохраняются как кандидаты Event без даты события и с тегом needs-event-review: дата публикации не подменяет дату мероприятия.",
          "channels.searchPosts может требовать Premium или Stars после бесплатных поисков; автоматическая оплата отключена.",
        ],
      };
    },
    async sync(ctx, options = { confirmed: false }) {
      const selected = settings(ctx, options);
      const response = await executeTelegramBatch({
        ...credentials(ctx),
        queries: selected.queries,
        operations: selected.operations,
        seedChannels: selected.seedChannels,
        resultsPerQuery: selected.resultsPerQuery,
        maxItems: selected.maxItems,
        minDate: options.startDate,
        maxDate: options.endDate,
        delaySeconds: 2.5,
      });
      const items = response.results.map(telegramRawItem);
      const postCount = response.results.filter(
        (item) => item.kind === "post",
      ).length;
      return {
        items,
        warnings: [
          `${response.requestCount} MTProto RPC; ${response.resultCount} уникальных публичных результатов; платных Stars: 0.`,
          ...(postCount
            ? [`Постов-кандидатов для последующего LLM-разбора: ${postCount}.`]
            : []),
          ...response.warnings,
        ],
      };
    },
    normalize(raw, ctx) {
      return telegramEntity(parseTelegramRaw(raw), ctx);
    },
  },
);

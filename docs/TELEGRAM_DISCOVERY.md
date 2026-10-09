# Telegram discovery: проверка кандидатов

Исследование состоит из отдельных read-only шагов, между которыми LLM отсеивает
неподходящие варианты. Нет автоматического импорта, вступления в группу или изменения
пользовательских оценок. Все research RPC последовательны: пауза 4 + 0–1.5 секунды,
до 20 каналов за вызов; FloodWait/ошибка авторизации останавливают выполнение.

## Порядок и tools

1. `telegram_search_public_chats` / `telegram_discovery_batch`: keywords, `store=false`.
2. `telegram_discovery_filter_candidates` принимает
   `{"candidates":[{"id":"1770025921","username":"serbia_progulki"}]}`.
   Numeric ID необязателен, но предпочтителен; username может быть @name или URL канала.
   Локальный поиск во всех Community, включая архив/filtered, original/overrides,
   по Telegram ID/external ID/username/URL. Возвращает `candidates` и `skipped` с
   причинами `alreadyStored`, `excluded`, `duplicateCandidate`; `requestCount=0`.
3. `telegram_channel_info`:
   `{"channels":["examplechannel"],"minParticipants":500}`.
   `channels.getFullChannel` возвращает `description`, свежий
   `channel.participantsCount`, `passesMinParticipants`, `isForum`, `linkedChat`
   (ID, доступные title/username/URL), `latestPinnedMessageId`.
   `passesMinParticipants=null` означает неизвестный размер, НЕ прохождение порога.
   Одна лишь тематика названия или большой размер не подтверждают релевантность.
4. `telegram_channel_pinned_messages`:
   `{"channels":["examplechannel"],"maxMessagesPerChannel":20}`.
   Возвращает все доступные текущие закрепы в пределах лимита, в том числе очень старые;
   не принимает даты. `messages.search` с `inputMessagesFilterPinned` фильтрует на
   стороне Telegram. Не сканирует историю. Контентные исключения ленты не скрывают
   правила/важные закрепы; запрет на чтение исключённых каналов сохраняется.
5. `telegram_discovery_recent_posts`:
   `{"channels":["examplechannel"],"maxPostsPerChannel":20,"maxScannedPerChannel":200}`.
   Тот же worker, metadata и saved exclusions, что у monitoring. Это последние
   хронологические сообщения, НЕ случайная/репрезентативная выборка. Опциональны
   `startDate`, `endDate`, `timeZone`, `beforeMessageIds` для более раннего окна.
6. Для форума (`isForum=true`) при необходимости получить `telegram_group_topics`,
   назвать в чате найденные темы и объяснить выбор ближайшей к цели. Затем
   `telegram_topic_posts` для выбранной темы; её можно уточнить через
   `telegram_search_channel_messages` с topicId (поиск доступен в ОБОИХ MCP).
   Контекстные tools тем/обсуждений доступны только в discovery.
   Для релевантного канала при конкретном вопросе проверить живое общение через
   `telegram_linked_chat_posts` или комментарии анонса через `telegram_post_comments`.
7. `telegram_channel_recommendations` от проверенных полезных seeds. Новые результаты
   снова проходят дедупликацию и проверку; рекомендации не доказывают релевантность.

После info можно повторить локальную дедупликацию по уточнённым ID/username.
Ни один research tool не делает глобальный поиск, не списывает Stars и не читает
частные личные диалоги. Доступное обсуждение без публичного username можно читать
только через подтверждённый linked_chat_id исходного публичного канала, без вступления.
Ссылки на приглашения, посты и произвольные сайты не подходят
в качестве канала. Сохранённые excludedChannels проверяются до Telegram RPC.

## Точечный поиск

```json
{
  "channels": ["examplechannel"],
  "query": "поход",
  "startDate": "2026-09-01",
  "endDate": "2026-10-03",
  "timeZone": "Europe/Belgrade",
  "maxMessagesPerChannel": 20
}
```

`messages.search`: непустой `query` до 200 символов, только выбранные каналы/группы.
Даты включительны и относятся к ПУБЛИКАЦИИ, не дате мероприятия. Без дат допустимы
старые совпадения. `topicId` опционально ограничивает поиск известной темой форума;
список тем сам этот tool не получает. `afterMessageIds` — исключительный нижний ID,
`beforeMessageIds` — исключительный верхний курсор по username.
Saved keywords/reply/ad exclusions применяются так же, как к monitoring; передача
пустых списков/false не отменяет сохранённых исключений. Поэтому отсутствие
возвращённых совпадений не обязательно означает отсутствие темы в сообществе.

У pins/search `maxMessagesPerChannel` по умолчанию 20, максимум 100;
`maxScannedPerChannel` по умолчанию 200, максимум 5000 и не меньше лимита сообщений;
`pageSize` 10–100, по умолчанию 100. «Scanned» здесь означает только серверные
совпадения поиска/закрепы, НЕ всю историю. Ответ содержит `requestCount`, `billing`,
warnings; по каждому каналу — `scannedCount`, `returnedCount`, `filteredCount`,
`filterBreakdown`, `totalMatches` (null, если Telegram не дал счётчик), `truncated`,
`nextBeforeMessageId`, `posts` с rich monitoring metadata.
При усечении продолжить с возвращённым курсором либо явно назвать выборку неполной.
Счётчик Telegram может относиться ко всем совпадениям до локальных исключений.

Проверять тематические совпадения вместе с обычной свежей выборкой: поиск по «AI»
не доказывает, что большая часть группы про AI. Пустая свежая выборка не доказывает,
что группа неактивна навсегда. Связанный чат исследуется под конкретный вопрос,
не импортируется автоматически и не наследует размер/релевантность канала.

## Темы форума

`telegram_group_topics`:

```json
{"channels":["examplegroup"],"maxTopicsPerChannel":50,"query":""}
```

`messages.getForumTopics` получает одну ограниченную страницу (лимит окна 1–100).
Telegram может дополнительно вернуть закреплённые темы сверх этого лимита;
`maxTopicsPerChannel` — лимит запроса, не жёсткое число элементов ответа.
Ответ по группе: `isForum`, `totalTopics`, `topics`, `truncated`, `nextCursor`.
У темы: строковые `id`, `title`, `topMessageId`, `url`, `createdAt`,
`lastMessageDate`, флаги `pinned`, `closed`, `hidden`. Неизвестная дата — null.
`query` необязателен и ищет название темы, не текст сообщений.
Для продолжения передать возвращённый `nextCursor` в `topicCursors[username]`:
`offsetDate` (ISO timestamp с timezone), `offsetId`, `offsetTopic` (числовые ID).
При объединении страниц дедуплицировать темы по ID; учитываются и pinned topics.
Отсутствие форума (`isForum=false`) отличается от пустой страницы тем.
Усечённая выборка не является полным списком; закрытая тема может содержать полезную
историю, но не доказывает текущую активность.

`telegram_topic_posts`:

```json
{"channels":["examplegroup"],"topicId":"42","maxMessagesPerChannel":20}
```

Ровно одна группа и положительный строковый `topicId` из списка (Telegram int32).
Обычная тема читается через `messages.getReplies` без загрузки всей истории.
«Общее» (`topicId="1"`) — особый случай: ограниченная история группы с исключением
сообщений остальных тем. Поэтому при большом объёме других тем маленький scanned-cap
может не найти сообщения «Общего»; не делать вывод о неактивности из неполной выборки.
Пример сообщения пользователю перед чтением: «Найдены темы “AI-митапы”, “Вакансии”,
“Общее”; ближе к цели “AI-митапы” (42), проверю свежую переписку».

## Связанные чаты и комментарии

`telegram_linked_chat_posts` принимает исходные публичные КАНАЛЫ публикаций:

```json
{"channels":["examplechannel"],"maxMessagesPerChannel":20}
```

Worker заново проверяет `channels.getFullChannel.linked_chat_id`, разрешает только
подтверждённую discussion supergroup и читает её ограниченную свежую историю.
Без auto-join/импорта или обхода доступа. Полезно проверить, есть ли за анонсами
реальное русскоязычное общение, вопросы новичков, совместные планы или обмен опытом.
Не нужно читать все обсуждения каждого кандидата по умолчанию.

`telegram_post_comments` принимает ровно один исходный канал и ID его поста:

```json
{"channels":["examplechannel"],"postId":"25","maxMessagesPerChannel":20}
```

`messages.getDiscussionMessage` находит автофорвард в связанном чате; worker проверяет
ID чата и provenance исходного канала/поста и только затем вызывает `messages.getReplies`.
ID исходного поста не используется как ID корня чата. Кейсы: уточнения даты/регистрации,
свободных мест, отмены, совместного транспорта или присоединения к прогулке/митапу.
Отличать сообщения организатора от предположений участников и учитывать их давность.

Общие параметры контекстных tools: `maxMessagesPerChannel` 1–100 (20),
`maxScannedPerChannel` до 5000 (200), `pageSize` 10–100 (100), опциональные даты публикации
и `timeZone`, `beforeMessageIds`/`afterMessageIds`. Ответ использует rich monitoring
posts, счётчики, `truncated` и `nextBeforeMessageId`, плюс `sourceChannel`, `topicId`,
`discussionRootId`, `status`. Для пагинации обсуждения использовать username
ВОЗВРАЩЁННОГО чата (для непубличного — его numeric ID), а не исходного канала.
Непубличные ссылки `https://t.me/c/<chatId>/<messageId>` работают только при доступе к чату.

`status=available` — чтение доступно (постов может быть ноль);
`noLinkedChat` — у канала нет связи; `linkedChatExcluded` — связанный чат исключён
настройками по username или известному стабильному ID. Недоступность возвращается
через warnings, а не маскируется как пустое неактивное обсуждение.
В явном исследовании темы/диалога ответы включены даже при `excludeReplies=true`
в ленте: иначе исчезла бы сама переписка. Настройки не изменяются, исключения каналов,
рекламных disclosures и keywords сохраняются. Pins остаются отдельным исключением.
Обсуждение как отдельный кандидат требует собственной проверки размера/языка,
дедупликации и подтверждения добавления. Размер исходного канала не переносится на чат.

## История и применение

Keyword discovery/recommendations по-прежнему ведут native `telegram_query_history`.
Research чтение само не добавляет каналы и не создаёт отдельные keyword-discovery
строки: выводы проверки связываются с исходным `historyRunId` через relevance marking
и query-summary. Отдельный scoped search при обучении стратегии можно записать
как receipt `messages.search` через `/api/ai-mcp-discovery/queries`, не выдавая число
найденных сообщений за число обнаруженных новых каналов. При технической проверке
MCP память пользовательских вкусов не изменяется.

После обновления переподключить оба MCP-процесса. HTTP Sync/UI по-прежнему имеют
только прежние discovery operations; новые research steps предназначены для модели.

## Канонический источник и кандидат

Текущий поиск/импорт в Community остаётся локальным. Для последующего review сохранять channel numeric ID/username/URL, title/description, provider/operation/query/time и причину релевантности. Сначала identity/dedupe (включая скрытые/исключённые карточки), затем description → pins → recent posts; выбранный канал — кандидат для отдельно согласованного Personal Radar Knowledge save. Source канала не равен Event/post. Этот workflow не пишет Knowledge автоматически. См. [модель владения](../../personal-radar/docs/storage-boundaries.md).

## Единый API и batch 50

[Telegram Connector](../../personal-radar/docs/telegram-connector.md) сохраняет прежние schemas и physical tools. Для logical read до 50 каналов использовать `telegram_batch_read` с requestId/execute=true; сначала plan, после потери ответа — `telegram_batch_result` без RPC. Сохранять independent cursors; watermark только complete. Respect FloodWait/hasUnread, не переисполнять unknown без human retryUnknown. Pins не фильтровать правилами ленты, discussion replies не исключать. Новая выдача — universal DTO/journal, не автоматический Community/Event import и не Knowledge write.

# Digest: реальные API и точки продолжения

## Подготовка и источники

Работать из актуального Activity Checker checkout. Стандартный API:
`http://127.0.0.1:4318/api`; база — `../data/activity-checker/activity.sqlite`,
если `ACTIVITY_DB` не переопределён. Не выводить секреты при определении runtime.
При недоступности API проверить штатный способ запуска проекта и запустить его,
если это необходимо для вызванного workflow. Старт может выполнять штатную
автоархивацию; учесть её, не приписывать одному ручному запросу все изменения.

`GET /bootstrap` содержит `scopes`, `sources`, `providers`, `entities`, `runs`,
`profile`, `filterRules`. У sources есть `enabled`, `scopeId`, `connection.canSync`,
`lastSyncAt`, `lastResult`, `provider.group`, `manualSyncOnly`, `webSearchLlm`.
Профиль и обе памяти: `GET /ai-mcp-discovery/context?scopeId=belgrade&limit=500`.
Пути обновления памяти — в sibling skills; pending обработать по fingerprint/revision.

API-агрегаторы: `provider.group === "API Агрегаторы"`, Event в supportedEntityTypes,
подключённый `enabled` источник с `connection.canSync`. Учитывать источники нужного
города и общестрановые, которые его покрывают; у страны — её города. Отключённые,
не настроенные и источники других географий не включать автоматически. Указанное
пользователем расширение географии важнее стандартного scope.

Проверять успешный sync для КАЖДОГО sourceId с `status="success"` и finishedAt
сегодня в scope.timezone. `/bootstrap.runs` ограничен последними 40 запусками.
Если истории не хватает, допустимо открыть реальную SQLite только для чтения
(`node:sqlite DatabaseSync(path, {readOnly:true})`, закрыть после чтения):

```sql
SELECT sourceId, MAX(finishedAt) AS lastSuccessAt
FROM sync_runs WHERE status='success' GROUP BY sourceId;
```

`lastAttemptAt`, успешный `/test` и partial не доказывают синхронизацию.
`lastSyncAt` ставится также при partial, поэтому сам по себе недостаточен.
Не создавать `Store` для диагностики: его конструктор изменяет базу.
В истории sync нет гарантированного диапазона исходного запроса: неизвестное
покрытие не объявлять подтверждённым. Обычный дневной sync повторять не нужно;
для заведомо другого периода проверить ограничения адаптера и дополнить web.

`POST /sources/:id/sync-plan` и `/sources/:id/sync` принимают поддерживаемые
`startDate`, `endDate`, `categories`, `resultsPerQuery`, `maxItems`, `confirmed`,
`previewId` (контракт `shared/model.ts`, `docs/API.md`). Не все адаптеры используют
все фильтры. Проверять результат и warnings, а не только HTTP 200.

AllEvents — API-агрегатор с `manualSyncOnly=true`: не забывать его, если он
подключён. План реально получает и кэширует страницы; передать его `previewId`
и неизменённые фильтры в sync с `confirmed=true`. Вызов digest уже разрешает этот
обычный бесплатный sync после проверки плана; отдельный вопрос не нужен.
Для платного плана действует согласованный бюджет. `/api/sync` пропускает
manual-only источники и не проверяет сегодняшнюю свежесть, поэтому удобнее
вызвать отобранные source IDs по одному. Общая блокировка SyncService не допускает
параллельные source-sync. При busy дождаться текущего запуска и перечитать историю.
Учитывать cooldown провайдера; не делать бесконечных повторов ошибок.

Одновременно с сетевым sync можно выполнить
`POST /entities/archive-past {"scopeId":"belgrade"}`. Архивируется по последней
известной дате события в локальном календаре, продолжающиеся сохраняются.
Telegram-прошедшее скрывается своим view, отдельной команды его архивации нет.

## Инкрементальный Telegram

Tools находятся в `activity-checker-telegram-monitoring`:
`telegram_monitoring_channels` и `telegram_monitoring_posts`.
Свежие settings: `GET /telegram-monitoring/settings`.
Получить полный список через channels с `limit:1000`, стандартными false для
`includeArchived`, `includeFiltered`, `includeExcluded`; разбить на batch до 20.
Ручной список имён из прошлого чата не заменяет текущие настройки базы.

Границу чтения определять ПО КАНАЛУ:

1. Если существует проверенный завершённый checkpoint digest с сохранёнными
   monitoring-снимками, использовать его `afterMessageId`.
2. При первом запуске взять максимальный ID сохранённого поста из SQLite, включая
   уже прошедшие Telegram-события. Текущее `/telegram-events` их не возвращает:

```sql
SELECT communityId, channelUsername, MAX(CAST(postId AS INTEGER)) AS lastPostId,
       MAX(json_extract(data, '$.publishedAt')) AS lastPublishedAt
FROM telegram_events GROUP BY communityId, channelUsername;
```

Это максимум **отобранных** постов, не всех просмотренных: безопасно перечитать
часть, но нельзя объявлять полноценной историей сканирования. `updatedAt`
события и `telegram_event_reviews.endDate` не являются watermark сообщения.
Последний review также может охватывать лишь часть каналов.
3. Без истории — последние 30 дней публикаций; границы посчитать от сегодняшней
   даты, не от будущего периода мероприятий. При уточнении далёких анонсов
   использовать server-side поиск `telegram_search_channel_messages` в конкретном
   канале, сверяя исходный пост. Никакого глобального paid-post search.

Пример вызова (подставить реальные usernames/ID):

```json
{
  "communityIds": ["community-id"],
  "afterMessageIds": {"username": "12345"},
  "endDate": "YYYY-MM-DD",
  "timeZone": "Europe/Belgrade",
  "maxPostsPerChannel": 200,
  "maxScannedPerChannel": 1000,
  "pageSize": 100,
  "delaySeconds": 5
}
```

`afterMessageIds` — исключительная нижняя граница ID; `beforeMessageIds` —
исключительный курсор следующей страницы к более старым сообщениям. Для
`truncated=true` сохранять исходный after и продолжать через `nextBeforeMessageId`
по username. Объединять страницы по channel ID + post ID. Не передавать dates
мероприятий как нижнюю границу публикаций: анонс мог выйти месяц назад.
Сначала дочитать промежуток, затем продвигать завершённую границу. При ошибке
или остановке сохранить старую границу и pending cursor; раскрыть неполноту.

Для повторных запусков сохранять реальные JSON-снимки в игнорируемом
`.runtime/digest/` с уникальным ID запуска и каналов. Это локальные данные
workflow, не новая SQLite-таблица. Рядом `telegram-checkpoints.json` с версией,
путём базы/scope, numeric channel ID, username, последней завершённой нижней
границей, pending cursor и ссылками на снимки. Хранить снимки с внепериодными
анонсами: при новом диапазоне анализировать их локально, даже если новых постов нет.
Не удалять старые снимки и не терять состояние параллельного запуска.

Продвинуть checkpoint можно только после сохранения всех страниц промежутка и
успешного review/import выбранных событий. Использовать максимальный реально
полученный ID; при полностью отфильтрованном ответе без ID оставить границу
прежней. Не выдумывать lastScannedId из счётчиков. Для обнаружения редактирования
старых анонсов полезно дополнительно перечитать последние 2–3 дня без after-ID,
а перспективные события проверить точечно. Заявлять только реально проверенное.

## Web и импорт

У sources с `provider.webSearchLlm=true` значение `enabled=false` и `canSync=false`
может означать отсутствие API-адаптера, а не запрет Web Search. В текущем каталоге
это, например, Meetup/Eventbrite/Belgrade Beat. Взять домены из source.url или
provider.docs/defaultUrl, прочитать текущие ограничения. Не запускать все записи
с группой LLM Web: ключевой флаг — webSearchLlm или явная исследовательская
инструкция источника. Учитывать явные исключения пользователя.

Поиск: `site:<domain> <город> <тема> <месяц/год/даты>` с полезными RU/EN/SR
вариантами. Открыть первичные страницы, проверить реальную дату/год, место,
отмену/перенос, условия участия. Недоступный оригинал — непроверенная находка,
не повод придумывать подробности. Поисковый recency — дата публикации, не события.

Подтверждённые новые Event: `POST /import/preview`, затем `/import`, с canonical
схемой из `/import/schema`. Сохранить оригинальный URL, stable externalId/knownIds,
проверенные поля, provenance и основание оценки. Точная копия уже существующего
события не требует нового импорта. Записи Community автоматически не добавлять.

После web-пакета сохранить реальные поисковые receipts через
`POST /ai-mcp-discovery/queries` с providerId `web-search`, operation `search`,
точным query, scopeId, runId, временем и фактическими результатами. Неизвестные
метрики — null. Для sync-анализа — фактический provider.id, operation `sync`,
query=URL/фильтры, runId из sync результата. Новых native Telegram-поисков в
обычном monitoring нет; не выдавать число постов за найденные каналы. После
receipts завершить query-summary по соответствующему API-reference.

## Review, дубли и запись score

Период событий и период публикаций хранить раздельно. Пересечение события с
дайджестом: начало не позже конца периода, последнее известное окончание
(`endAt || startAt`) не раньше начала периода; сравнивать даты/время в scope.timezone.
Карточка без достоверной даты остаётся кандидатом на уточнение.

Canonical `GET /bootstrap` и `GET /entities/:id` + Telegram
`GET /telegram-events?scopeId=…` / `GET /telegram-events/:id` дают карточки для review.
Проверка всех копий может требовать чтения других фильтров/SQLite read-only,
но изменять только согласованный набор. Для дублей:

- `PATCH /entities/:id {"skipped":true,"skipReason":"дубль"}`;
- `PATCH /telegram-events/:id` с тем же payload.

Проверить ответ/GET. Skip — не dislike и не отрицательный feedback; при уже
существующей реакции/звёздочке не сбрасывать её. Не менять Community через этот
endpoint: skip для канала не поддерживается. Исключения каналов не трогать.

Canonical AI-score: свежий `/ai-events-review/context`, обработанный pending,
`POST /ai-events-review/scores` с fingerprint и expectedSummaryRevision, до 100 ID.
Его candidates допускают существующий aiScore, но не личные реакции/skip/favorite,
не прошедшие и не начавшиеся ранее события. Для рассмотренных понравившихся,
избранных или продолжающихся карточек digest разрешает переоценку AI-полей:
получить свежую полную карточку, взять только canonical поля из `/import/schema`,
изменить AI-поля и отправить `PUT /entities/:id`; проверить личное состояние.
Этот общий PUT не имеет защиты fingerprint: повторно проверить свежесть перед
записью и не перетирать одновременную ручную правку. Архивные карточки не восстанавливать.

Telegram score хранится как `relevanceScore` (текущий контракт: integer 1–10),
а не canonical aiScore 0–10. Не отправлять 0 и не создавать несуществующий
score-endpoint. Для создания/переоценки получить
`GET /telegram-events/review-context` (profile + fingerprint), затем
`POST /telegram-events/review`:

```text
{startDate, endDate, expectedProfileFingerprint,
 monitoring: <настоящий MCP-снимок>, selections: [...], channelReviews: [...]}
```

Точный selection — `shared/telegram-events.ts`: communityId, postId, activityKey,
title, startAt/endAt, country/city/venue, relevanceScore, relevanceReason,
validationNotes. Для существующей карточки сохранять её activityKey: это часть
стабильного ID. Даты верхнего review относятся к публикациям; должны включать
исходные посты, а не только даты будущих мероприятий. При объединении страниц
сохранить реальные посты, корректные counters/range, убрать повторяющиеся ID.
Review повторного ID обновляет данные, сохраняя личные состояния.

Существующее Telegram-событие может ссылаться на старый пост вне нового batch.
Взять реальный сохранённый monitoring-снимок либо перечитать пост узким
ID-интервалом (`afterMessageIds=postId-1`, `beforeMessageIds=postId+1`, строки),
без ограничения публикаций датами дайджеста. Не синтезировать MCP-ответ из fullText.
Endpoint отклоняет прошедшие события, replies, явную рекламу и исключённые посты.
При отказе отметить несохранённую оценку; не писать SQL и не утверждать успех.
Исторический дайджест допускает чтение архива, но Telegram API не позволяет
переоценить уже прошедшее таким import: явно обозначить это ограничение.

Финальная проверка: импортированные ID читаются, AI-поля сохранены, дубли skipped,
нет потерянных пользовательских реакций, source failures/truncation перечислены,
pending feedback/query memory обработан. Никаких гарантий полноты всех событий
города по одной индексированной выдаче или ограниченной выборке Telegram.

## Сохранённые AI-дайджесты

После review по умолчанию сохранять результат в `ai_digests` той же SQLite;
исключение — явное «только в чате». Это снимок, не дубли Event и не новые каналы.
Проверить `GET /api/ai-digests/schema`, затем `POST /api/ai-digests`:

```json
{
  "id": "<новый UUID для подборки>",
  "scopeId": "belgrade",
  "title": "Выходные в Белграде · 10–11 октября",
  "requestSummary": "Подобрать активности на 10–11 октября под мой профиль, включая поездки из Белграда.",
  "startDate": "2026-10-10",
  "endDate": "2026-10-11",
  "notes": "Ограничения проверки и неизвестные детали.",
  "items": [{
    "title": "Название события",
    "description": "Что это, почему подходит, место и проверенные цена/условия.",
    "startAt": "2026-10-10T19:00:00+02:00",
    "endAt": "",
    "aiScore": 8,
    "sourceName": "Название сайта или Telegram-канала",
    "sourceUrl": "https://example.com/original-announcement",
    "eventUrl": "https://example.com/event",
    "tags": ["музыка", "социальное"]
  }]
}
```

`startDate/endDate` — включительный период запроса в календаре scope. Строки должны
пересекаться с ним. `startAt/endAt` строки — ISO date либо datetime с offset;
у фестиваля сохранить полный подтверждённый диапазон, даже выходящий за период.
`eventUrl` необязателен, `sourceUrl` обязателен, только HTTP(S). Источник — конкретный
канал/сайт со ссылкой на анонс, не просто «Telegram». Оценка 0–10. До 100 строк;
пустая подборка допустима с объяснением. Не заполнять её выдуманными событиями.

`tags` — до 12 коротких тематических тегов без `#` и пробелов (слова можно соединять
дефисом), до 50 символов каждый. Хранятся в нижнем регистре без дублей; старые строки
без поля читаются как `[]`. Хештеги не нужно дублировать в `description`.
Для разметки тегами существующего снимка: перечитать его, затем
`PATCH /api/ai-digests/:id/tags` с `{ "expectedItems": <полученные items>,
"tags": <массив массивов тегов в том же порядке> }`. Обновляются только теги;
несовпадение снимка отклоняется. Не менять остальное содержимое через этот маршрут.

POST идемпотентен для того же ID/payload; иной payload под занятым ID отклоняется
без перезаписи. Проверить `GET /api/ai-digests/:id`. Список:
`GET /api/ai-digests?scopeId=belgrade&archived=false` (архив: `archived=true`).
Сортировка по `endDate`, затем `startDate`. `POST /api/ai-digests/archive-past`
с `{ "scopeId": "belgrade" }` архивирует карточки с `endDate < today` в timezone scope.
Общая ручная архивация мероприятий также включает дайджесты; автоматическая — при
старте веб-сервиса и sync, с общей настройкой opt-out. GET не архивирует.
Историческая подборка создаётся сразу в архиве. Строки/ссылки остаются независимо
от дальнейшей архивации или изменения исходных карточек.

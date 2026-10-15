# API и источники рекомендаций

Работать из актуального checkout Activity Checker. API по умолчанию
`http://127.0.0.1:4318/api`; проверить `/health`. Другой порт/путь брать из штатной
конфигурации без вывода секретов. При необходимости запускать штатный сервис;
не использовать `new Store` для диагностики live DB. Мутации — JSON.

## Контракт страницы

- `GET /recommendations?scopeId=belgrade&kind=week` — `settings`, `snapshot` или
  null, актуальный `period` и `timeZone`.
- `GET /recommendations?scopeId=belgrade&kind=concerts-2026` — отдельный годовой снимок.
- `GET /recommendations/schema` — текущая JSON Schema входа для POST.
- `PUT /recommendations/settings` — `{expectedRevision, prompts: {sport, walks,
social, concerts}}`. Только при явном запросе изменить критерии; обычное обновление
  рекомендаций читает их. Промпты общие для географий и двух вкладок.
- `POST /recommendations` — сохранить новый полный снимок выбранной вкладки.

Личные события (`personal` в GET) хранятся отдельно и сохраняются при публикации.
Не включать их в `items`, scoring, профиль или память предпочтений; модель принимает
только четыре исходные группы. Не удалять и не восстанавливать личные записи при обновлении.

## Скрытые события до LLM-анализа

`POST /recommendations/filter-candidates` принимает `{scopeId, candidates}` (до 2000).
Каждому кандидату достаточно `title`, `startAt`, `sourceName`, `sourceUrl`;
`eventUrl` и `endAt` необязательны. `description`, `aiScore` и `group` не нужны.
Дополнительные поля сохраняются. Ответ — `{candidates, excludedCount, hiddenCount}`;
исключённые исходные тексты не возвращаются. Endpoint не вызывает модель/providers.

Полученные выгрузки держать на диске. Для каждого пакета сначала извлечь минимальные
идентификационные поля (время в часовом поясе географии, название и источник).
Запускать **до** помещения описаний кандидатов в контекст, scoring, ranking и review:

```bash
node --import tsx scripts/filter-recommendation-candidates.ts \
  .runtime/recommendations/<run>/candidates.json \
  .runtime/recommendations/<run>/eligible.json belgrade
```

Input — JSON-массив; output должен быть новым файлом. Для нестандартного порта можно
передать четвёртым аргументом API base `http://127.0.0.1:<port>/api`. Helper пишет
только допустимые карточки, в stdout — путь/количества. После него читать в LLM
только eligible-файл. При ошибке endpoint/helper не продолжать scoring нефильтрованного
пакета: проверить запущенную версию сервиса и сообщить ограничение.

Для Telegram сохранить исходные raw-посты и checkpoints всех каналов без усечения.
Если дата/название требуют извлечения из естественного текста, это отдельный этап
извлечения, без анализа личной релевантности; затем фильтр и только потом review.
Не исключать целый сборный пост по одному скрытому событию. Для старых canonical/
Telegram candidates использовать фактические sourceName/sourceUrl и дату; не подменять
их названием пользователя, venue или именем агрегатора из другого анонса.
При чтении GET контекста извлекать настройки, period/timeZone, ID снимка и профиль;
не выводить полные hidden/snapshot/candidates в LLM до фильтра.

Сопоставление: локальная дата сеанса + нормализованные название/имя источника либо
название/Telegram-канал (новый post ID допустим), либо прямая eventUrl без tracking.
У Telegram eventUrl дополнительно проверяется название, чтобы не блокировать другие
события того же поста. Другие даты одного повторяющегося события не блокируются.
Изменённое время в пределах дня сохраняет скрытие. Нет нечёткого matching или обучения
summary по скрытию. При полностью иных названиях/ссылках детерминистическое совпадение
не гарантировано; не объявлять такой случай отфильтрованным без доказательства.

`GET /recommendations/hidden?scopeId=…` показывает активное скрытое для диагностики;
hide/restore — только по пользовательскому действию. Истёкшие записи очищаются
сервисом и не блокируют новые сеансы. После многодневного поиска перечитать period
и повторить фильтр непосредственно перед публикацией.

Payload (даты/ссылки ниже — пример формы, не реальные рекомендации):

```json
{
  "id": "<новый UUID>",
  "scopeId": "belgrade",
  "kind": "week",
  "startDate": "<period.startDate из свежего GET>",
  "endDate": "<period.endDate из свежего GET>",
  "settingsRevision": 0,
  "expectedSnapshotId": null,
  "requestSummary": "Подборка по текущим критериям, Белград, сегодня–воскресенье",
  "notes": "Свежесть агрегаторов, покрытие Telegram, web и ограничения",
  "items": []
}
```

Строка items:

```json
{
  "group": "social",
  "title": "<точное название>",
  "description": "<1–2 предложения о программе и участии>",
  "startAt": "<YYYY-MM-DD или ISO datetime с offset>",
  "endAt": "",
  "aiScore": 8,
  "sourceName": "<название канала/источника>",
  "sourceUrl": "https://t.me/<channel>/<post>",
  "eventUrl": "https://<organizer>/<event>",
  "tags": ["социальное"]
}
```

При отсутствии отдельного URL события `eventUrl` можно оставить пустым: карточка
ссылается на sourceUrl. Для Telegram обязательно сохранять прямой URL поста,
не только главную канала. Лимит 500 items, score 0–10; дату без времени не заменять
timestamp. Дата начала items должна входить в период. События должны оставаться актуальными
на момент сохранения. В UI каждый сеанс показывается только на дате начала,
занимает условный час; реальное endAt сохраняется без подмены.
Недельный период должен точно совпадать с текущим GET; при смене дня перечитать.
Годовой — `2026-01-01`–`2026-12-31`, только group=concerts. Уже прошедшие сеансы
того же дня с известным временем исключаются; сегодняшняя date-only допустима.

`expectedSnapshotId` — ID текущего снимка **этого scope и kind**, либо null.
`settingsRevision` — текущая ревизия промптов. При конфликте HTTP 400 и текст причины:
перечитать соответствующий GET, пересмотреть affected selection, новый POST.
Не менять live SQLite напрямую. Повтор того же UUID/payload идемпотентен даже после
появления более нового снимка; повтор другого payload с тем же UUID отклоняется.
Старые снимки сохраняются, страница показывает последний; две вкладки независимы.
После POST проверить `snapshot.id` в GET, counts и дату `updatedAt` (серверное время).

## Полный список Telegram из Knowledge

`GET /recommendations/sources?scopeId=belgrade` даёт тот же локальный список, который
показан в настройках страницы: `telegram`, `other`, `additional`, ревизию Knowledge
и `warning`. Telegram получен из всех shards канонического manifest по фильтру
коллекции, локальные исключения помечены enabled=false. Использовать полный
telegram-массив как актуальный перечень; при warning не считать пустой ответ
успешным покрытием, проверить каталог способом ниже. `other` — агрегаторы/LLM Web,
`additional` — ссылки из сохранённых подборок, а не полный список выполненных
поисков. Endpoint не вызывает Telegram или внешние API.

Каноническая коллекция:
`../personal-radar/knowledge/collections/activity-telegram-channel-monitoring.yaml`
(путь относительно checkout Activity Checker). Она выбирает enabled public channels,
platform=telegram, domains содержит activities, roles содержит activity_monitoring.
`activity-telegram-sources` включает также disabled/group records и служит сверке;
не подменять им активный список без явного расширения запроса пользователя.

При доступном Personal Radar retrieval — разрешить эту коллекцию и получить все
страницы источников и полные карточки/описания. Если retrieval не доступен, читать
локальные индексы **только для чтения**:

1. `../personal-radar/knowledge/indexes/manifest.json`.
2. Каждый путь из `datasets.sources.paths` относительно корня Personal Radar.
   Это JSONL shards, нельзя брать только первый файл или первые N строк.
3. Отобрать точным фильтром коллекции; usernames/URLs брать из metadata/locator,
   names/summary/description — из records. Прочитать соответствующие source YAML
   по `path` для полного описания. Не читать соседние секреты/чужие domains.
4. Дедуплицировать по stable source ID и telegram username/ID. Сверить
   `/telegram-monitoring/settings` и `telegram_monitoring_channels` с limit=1000
   (список Community — вспомогательный, не единственный источник списка).
5. Для каждого записать реальный итог чтения и pending pagination, включая
   Knowledge-каналы без local Community. Не импортировать/включать новые Community
   и не мигрировать Knowledge для возможности читать публичный username.

`telegram_monitoring_posts` принимает `channels: ["@username", "https://t.me/…"]`
и communityIds. Для Knowledge-источников без local mapping использовать channels.
Публичные группы `telegram_kind=group` — отдельные reference-источники; чтение только
доступным разрешённым средством, не auto-join. Их недоступность раскрывать отдельно,
не называть группой непрочитанный публичный канал.

Границы publication/message IDs, snapshots, `truncated`, checkpoints, FloodWait и
review/import описаны в репозиторном `skills/digest/references/workflow.md`, секции
«Инкрементальный Telegram» и «Review». Переиспользовать `.runtime/digest/` и корректные
watermarks; не продвигать их через непрочитанные страницы. При годовой подборке
читать сохранённые raw-посты и старые проверенные анонсы даже без новых сообщений.
Дата запроса концертов не служит lower bound публикаций.

## Агрегаторы и web

Bootstrap даёт актуальные source IDs, provider capabilities и runs. Afisha берёт
все страницы общего `/ru`; startDate/endDate не являются его серверным фильтром.
Для рекомендаций отдельно исключать раздел «Экскурсии» по section/rawCategory,
а не любое слово «экскурсия» в тексте похода. Для festivals в AllEvents учитывать категории festivals и food-drinks наряду
с music/concerts/comedy; не ограничивать годовую выгрузку только музыкой.
AllEvents поддерживает date/category
plan; при сочетании недели и года можно выполнить один широкий подтверждённый
проход и отобрать локально, учитывая page cap, warnings и заявленное покрытие.
Если широкий план обрезан, дополнить более узкими ranges/categories или web,
не выдавать ограниченную выгрузку за полный годовой каталог.

Web domains получать по `provider.webSearchLlm` и актуальным URL metadata;
Meetup.com — обязательный поиск для социальных/групповых активностей, если доступен.
Пример запросов: `site:meetup.com Belgrade October 2026 language exchange`,
`Belgrade beginner padel <dates>`, `Belgrade hiking <dates>`,
`<artist> Serbia 2026 official tour`, `Belgrade Russian standup November 2026`.
Проверять оригинал, не брать дату индексации за дату мероприятия.
Поисковые receipts/query-summary, canonical import и отдельный Telegram import
выполнять штатными путями digest. Не хранить источники в новом отдельном списке.

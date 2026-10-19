# Источники Кишинёва: реализация 16 октября 2026

География `chisinau` (MD, Europe/Chisinau) имеет отдельные источники и три снимка:
текущая неделя, следующая неделя, концерты 2026. Верхний переключатель города
сохраняет вкладку. Профиль и критерии sport/walks/social/concerts общие;
приоритет русскоязычным событиям, английский подходит. Язык сайта не доказывает язык шоу.

| Source ID | Получение | Покрытие и ограничения |
| --- | --- | --- |
| `source-fest-md` | HTML списка + детали | Весь список, только явные даты, подтверждённый город; без кино/детских разделов/постоянных экспозиций. |
| `source-iticket-md` | HTML + публичный Livewire loadMore + Event JSON-LD | До конца выдачи с проверкой page/snapshot/pager. Каждый подтверждённый сеанс date slider сохраняется отдельно со стабильным ID. Query city ненадёжен: город проверяется в деталях. Нулевой placeholder цены не означает бесплатность. |
| `source-afisha-mira` | WordPress REST city=205 + детали | Все REST-страницы по headers. REST date — публикация, время берётся из основного блока события в Europe/Chisinau. |
| `source-allevents-chisinau` | Общий AllEvents transport с city=chisinau | Отдельный source; прежние sync-plan, previewId и confirmed. Belgrade не перенастраивается. |
| `source-afisha-md` | Anonymous renderer + публичный sitemap + HTML/renderer деталей | Рендер подтверждает список, sitemap перечисляет страницы и языковые варианты. Без внутреннего /api, аккаунта или CAPTCHA bypass. |
| `source-sporter-md` | Публичные Next initialData + детали | Проверяются totalCount/hasMore, ссылки React references и дата сеанса. Неизвестная пагинация явно partial. Город из основной карточки либо проверенной площадки Knowledge. |
| `source-moldova-travel` | Публичный календарь + детали | Только дата с явным годом. Карточки без года перечисляются в unresolved; текущий год не подставляется. География не выводится из адреса издателя. |
| `source-frc-chisinau` | Anonymous Meetup renderer | Только реально опубликованные встречи. No events yet — пустой завершённый список; общий график по субботам не создаёт события. |

Обход сохраняет очередь, cursor, результат и discovery в ignored `.runtime/provider-crawls/`.
По умолчанию 24 детали за физический вызов, `maxItems` до 100; `maxPages` discovery
до 100 за вызов. Это ограничение одного вызова, а не всего каталога. Повтор с теми же
датами продолжает очередь; иные диапазоны имеют независимые checkpoints. Ошибка
транспорта оставляет текущую страницу pending. Завершённый результат кэшируется на
6 часов; незавершённый сохраняется до продолжения. Анонимные iTicket cookie/CSRF
хранятся только в приватном ignored runtime, без аккаунта и оплаты.

`SyncResult.coverage` содержит complete, discoveryComplete, processed, total,
remaining, unresolved, requests, resumed. complete означает завершённый обход;
unresolved и warnings отдельно раскрывают неподтверждённые даты/город и удалённые
страницы. Ошибка/partial не обозначается успешным полным покрытием. SyncService
сохраняет partial, если очередь или discovery не закончены.

Обычный batch обновляет Fest/iTicket/Афишу мира; AllEvents использует sync-plan,
Afisha.md/Sporter/Moldova Travel/FRC — отдельные manual sync. Источники читать
последовательно. Один общий диапазон можно использовать для двух недель и дальних
анонсов, затем разложить результат по независимым снимкам. Частичное покрытие
дополнять целевым web search по датам, артистам и площадкам.

Активные Telegram: afficherchisinau, afisha_kishinev, guleaimd, kulturny_kishinev,
friends_md, CC_151 и публичная группа VoleiNet (rich/group-capable reader).
Для трёх социальных источников применять
[workflow отбора](../../personal-radar/workflows/chisinau-activity-monitoring.md):
CC_151 — подтверждённый русский язык события и релевантность профилю; FRIENDS —
конкретные офлайн-встречи; VoleiNet — уровень, переносы и отмены игр.
selectedbylocals и centrultineretchisinau сохранены как отключённые reference-источники:
много новостей/отчётов и молодёжная/румынская специфика. Полный список брать из
Knowledge, чтение username не требует создания Community. Raw monitoring/checkpoints
сохраняются отдельно от domain import; Stars не используются.

Дополнительный web-пул: Locals, Artcor, America House, Tekwill, TopAlpine,
[#diez](https://diez.md/category/evenimente/) (`source-diez-md`) и
[E-Tineret](https://e-tineret.md/) (`source-e-tineret-md`). Новые два источника
включены в Personal Radar как `web_search`, без отдельного API-адаптера.
При обновлении модель проверяет язык самой программы (RU в приоритете, EN допустим),
возрастные условия/допуск и соответствие профилю; подробности в
[workflow](../../personal-radar/workflows/chisinau-activity-monitoring.md).
KEDEM (`source-kedem-md`) и InterNations (`source-internations-chisinau`) сохранены
отключённым reference-резервом и не входят в обычный обход.
Нужны
свежие конкретные анонсы; устаревшее расписание и поисковый сниппет не подтверждают встречу.

Transport/parsers: Personal Radar `connectors/connectors-ts/src/activity/moldova-events/`;
адаптер Activity Checker: `server/providers/websites/moldova.ts`. Общая библиотека
не знает Store, профиль или реакции. Старая публичная TS/Python import surface
сохранена при тематической реорганизации.

Канонический каталог Radar: `aggregators_activity/{serbia,moldova}`,
`telegram/{serbia_activity,moldova_activity}`, проверенные MD-площадки —
`venues_activity/moldova`. Selection использует IDs/metadata и все shards manifest,
а не физический путь. Локальный UI читает рабочие индексы; remote MCP — опубликованную
Git revision. Публикация не запускает провайдеры и не импортирует события автоматически.

## Проверенный запуск

16 октября 2026 опубликован Radar commit `59b41ae2166abfbc11317f4a205c62fac0caf0fc`.
Оба GitHub CI завершились успешно; remote `radar_get_source` подтвердил новые
карточки Sporter и «Культурного Кишинёва» на этой revision. Приватный Personal Radar
MCP обновлён до `0.15.4`: `allevents_read_events.city` принимает belgrade/chisinau,
default остаётся belgrade; город входит в selection и durable request identity.
Существующие D1 bindings, секреты и приватная аудитория сохранены.

Полный обход: Fest 127/127; iTicket 345/345 карточек и 333 сеанса (11 unresolved);
Afisha.md 80/80 страниц, 65 событий (3 unresolved); Афиша мира 80/80, 4 будущих
события; AllEvents 4 страницы/153 карточки; Sporter 5 подходящих деталей/4 события
(1 unresolved). Moldova Travel: все 56 карточек требуют подтверждения года;
Meetup FRC: встреч нет. Это покрытие выбранных каталогов, не всех событий города.

Сеансы iTicket имеют отдельную identity `iticket_session` и source externalId
`session:<id>@<datetime>`; Store не применяет к разным датам этих сеансов прежнее
агрессивное объединение повторов. Тест проверяет ingestion, повторный sync и
collapse. География Sporter читается из полных generated records: compact shards
не содержат source_kind. Отменённая тренировка 17 октября пропущена нейтрально.

Четыре активных Telegram-канала: 161 пост за 17.09–16.10, без усечения, 9 RPC.
Из дополнительных разрешённых 50 использованы 2; Stars не использовались.
Через Catalog Sync созданы четыре выбранные локальные Community с MD/Chisinau,
без изменения сербских карточек; перед записью сделан проверенный WAL-aware backup.
Telegram review сохранил 10 сеансов, canonical AI-review — 33 оценки. Подтверждённые
14 дублей и 1 отмена отмечены skipped, без отрицательной реакции.

Сохранены снимки Кишинёва: текущая неделя — 3 записи, следующая — 14, годовой
календарь — 38. Поисковые receipts сохранены, pending query/feedback = 0.
Природных выездов с подтверждёнными датами, ценой и логистикой на эти две недели
не найдено; пустая группа не заполнялась вымышленными встречами.

Проверки: Activity 370 tests + check/build; TS connectors 66 tests + build/Worker
typecheck; Radar publication snapshot 140 Python tests + 9 retrieval tests +
generated indexes/write contracts; приватный MCP 205 tests + check/build.
В браузере проверены обе недели, текст запроса и переключение городов с сохранением
выбранной вкладки. Исходные ответы, checkpoints и доказательства выполнения остаются
в ignored `.runtime/recommendations/md-complete-20261016/`.

Установленные `activity-recommendations` и `digest` ссылаются на канонические
репозиторные скиллы. Предыдущая установленная копия digest сохранена вне активного
каталога skills; новые инструкции по Молдове применяются и при прямом вызове digest.

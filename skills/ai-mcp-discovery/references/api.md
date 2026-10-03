# Activity Checker: discovery context и память поиска

Стандартный API: `http://127.0.0.1:4318`, либо `http://activity-checker.localhost`.
Проверить `/api/health`; при другом порте взять реальную конфигурацию без вывода
секретов. Canonical repo находится в `activity-checker/` Life Stack; рабочая SQLite
по умолчанию — соседний `data/activity-checker/activity.sqlite` (`ACTIVITY_DB` может
переопределить). Мутации — JSON, `Content-Type: application/json`.

При отсутствии новых endpoints нужна актуальная версия и штатный перезапуск API.
Не заменять их прямыми правками SQLite. `new Store` для диагностики не использовать:
конструктор применяет миграции и другие housekeeping-операции. Эта память не запускает
MCP, не расходует внешние квоты и не является разрешением на поиск/импорт.

## До поиска и после каждого batch

`GET /api/ai-mcp-discovery/context?scopeId=belgrade&limit=200` возвращает:

- `scope`, `now`, `profile` — география и свежий профиль страницы «Мой профиль»;
- `preferenceSummary`, `reviewedFeedback`, `pendingFeedback` — та же память реакций,
  что в AI-review; изменений/копии отдельного preference-summary нет;
- `querySummary: {summary,revision,updatedAt}` — компактная память поисковых стратегий;
- `reviewedQueries[]` — `queryId`, fingerprint, исходный snapshot, conclusion, revision;
- `pendingQueries[]` — ещё не учтённые или изменённые запросы и `previousConclusion`;
- `pendingQueryCount` — полный размер pending (пакет ограничен `limit`, максимум 500);
- `queryCount`, `keywordStats` — история и наблюдаемые метрики по ключевику,
  провайдеру, operation, scope и параметрам; неизвестный relevance-rate — `null`;
- `quota.googlePlaces` — текущие локальные SKU-счётчики, пределы, остатки, период.
  Использование за пределами приложения не видно; история receipts не является
  дополнительным счётчиком списаний. Apify-баланс API этой памяти не получает.

Нативные `telegram_query_history` и завершённые `google_places_api_usage` читаются
без копирования: ID имеют префиксы `telegram:` и `google-places:`. Google `reserved`
не участвует в обучении до завершения; квота консервативно считает reservations.
Старая Telegram-история не содержит scope — возвращается `scopeId=""`, не угадывать.
В ней также нет надёжного per-query признака усечения/global maxItems: нулевая
сохранённая выдача не доказывает, что метод исчерпал все результаты по ключевику.
Дата, параметры и исход сохраняются; новые relevance-marking Telegram снова делает
соответствующие запросы pending. Ошибка провайдера не считается нерелевантной выдачей.

Preference-summary обновлять существующим
`PUT /api/ai-events-review/summary` с `expectedRevision`, `summary`,
`evidence:[{eventId,fingerprint,conclusion}]`; контракт и лимиты описаны в
[AI-review API](../../ai-events-review/references/api.md). Прочитать этот reference
перед обновлением пользовательского summary или сохранением canonical scores.

## Receipts провайдеров без native history

`POST /api/ai-mcp-discovery/queries` — до 100 реальных запросов в одном атомарном пакете:

```json
{
  "queries": [
    {
      "queryId": "stable-run-id:query-1",
      "snapshot": {
        "providerId": "apify-instagram",
        "operation": "search",
        "query": "belgrade wine tasting",
        "scopeId": "belgrade",
        "runId": "stable-run-id",
        "executedAt": "2026-10-02T12:00:00Z",
        "outcome": "success",
        "returnedCount": 10,
        "relevantCount": 3,
        "storedCount": 2,
        "requestCount": null,
        "costUsd": null,
        "parameters": { "resultsPerQuery": 10 },
        "notes": "3 подходящих анонса; 1 уже есть в базе. Цена не известна."
      }
    }
  ]
}
```

Использовать фактический provider ID, а не пример выше. `outcome` — `success`,
`error` или `unknown`; все неизвестные счётчики/стоимость — `null` (по умолчанию).
`parameters` — плоские значения string/number/boolean/null, без секретов и полных
неограниченных payload. При агрегаторе без keyword поле `query` может содержать
его реальный URL/категории, `operation="sync"`, notes поясняет отсутствие text-search.
Не записывать планы как совершённые запросы.

Ответ: `{recorded,queryIds:["recorded:stable-run-id:query-1"]}`. Один `queryId`
обозначает один запрос: повторная запись безопасно уточняет метрики/notes, но нельзя
подменить provider, operation, query, scope, время, run или параметры другим поиском.
При утрате ответа повторить ровно прежние ID/payload. Provider-native receipts не
дублировать сюда. Историческую relevance-проверку native receipt сохранять в его
conclusion; для Telegram сначала можно обновить штатный relevance-marking.

## Сохранить query-summary

`PUT /api/ai-mcp-discovery/summary`:

```json
{
  "expectedRevision": 0,
  "summary": "Telegram: короткие … дают …; слишком общие … пока шумные. Google Pro: …",
  "evidence": [
    {
      "queryId": "ID из pendingQueries",
      "fingerprint": "64-символьный SHA-256 из pendingQueries",
      "conclusion": "Этот keyword дал 3 релевантных из 10; 1 дубль. Небольшая выборка."
    }
  ]
}
```

Summary — до 5000 символов, conclusion — до 2000, до 500 ID за запрос.
Summary и evidence обновляются атомарно. Повтор ID, устаревшая revision, изменившийся
fingerprint или ID не из pending отклоняют весь пакет. Перечитать context, пересмотреть
выводы и отправить свежий payload. При большом pending обрабатывать последовательные
пакеты: перечитывание возвращает следующую порцию. Ошибка — HTTP 400 `{error}`,
не считать её подтверждением записи. Native статистика сама не генерирует LLM-выжимку.

## Запись находок / синхронизация

`GET /api/bootstrap` — актуальные sources/provider capabilities, filter rules,
канонические карточки. `GET /api/import/schema`, `POST /api/import/preview`,
`POST /api/import` — проверенный canonical import. `POST /api/sources/:id/sync-plan`
и `/sync` — штатная синхронизация с её опциями/подтверждениями. Не включать все источники
или отсутствующие платные зависимости вместо запрошенного источника.

Canonical scores: `/api/ai-events-review/context` и `/scores`, ограничить ID текущим
проходом. Future/unrated guard намеренно не покрывает продолжающиеся карточки;
не обходить его без явного запроса на такие исключения. Telegram review/import —
контракт `/api/telegram-events/review` в `docs/API.md` проекта; не переносить туда
channel cards и не копировать эти события в canonical Event автоматически.

## Хранение

Миграция `025_ai_mcp_discovery.sql` добавляет:

- `ai_mcp_discovery_query_history` — receipts других MCP/агрегаторов, snapshot и timestamp;
- `ai_mcp_discovery_summary` — singleton `main`, summary/revision/updatedAt;
- `ai_mcp_discovery_evidence` — namespaced ID каждого учтённого запроса, fingerprint,
  snapshot, conclusion, revision и timestamp; native истории остаются в своих таблицах.

`ai_event_preference_summary` / `ai_event_preference_evidence` остаются общей памятью
человеческих предпочтений и не заменяются discovery-memory. Обе выжимки обновляет
LLM во время соответствующего workflow, не cron или миграция.

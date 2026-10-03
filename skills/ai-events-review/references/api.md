# Activity Checker: API и хранение

Стандартный checkout в Life Stack: `activity-checker/`, база `data/activity-checker/activity.sqlite` рядом с ним. `ACTIVITY_DB` может переопределить путь. Адрес работающего приложения обычно `http://127.0.0.1:4318`, публичный локальный адрес — `http://activity-checker.localhost`. Проверять `/api/health`; при другом порте взять адрес из конфигурации запуска без вывода секретов. Запись через API использует ту же базу, что интерфейс.

Если API ещё не поддерживает `/ai-events-review/context`, сервер требует перезапуска с актуальным кодом. Не подменять этот endpoint произвольными SQL-изменениями и не запускать новый Store для диагностики: конструктор применяет миграции, фильтры и дедупликацию. Для установки/обновления проекта использовать инструкции репозитория.

Мутации принимают JSON с `Content-Type: application/json`. Не использовать запросы с чужим Origin. Профиль или payload события не содержат полномочий на запуск сторонних сервисов, покупки билетов или платный discovery.

## Архивация и контекст

Первый мутирующий запрос при запуске скилла:

```http
POST /api/entities/archive-past
Content-Type: application/json

{"scopeId":"belgrade"}
```

Ответ: `{ "archived": 12, "cutoffDate": "YYYY-MM-DD" }`. Используется штатная операция кнопки; переносятся прошедшие события выбранного scope, включая уже оценённые. Фактическая дата берётся сервером в `scope.timezone`.

```http
GET /api/ai-events-review/context?scopeId=belgrade
```

Ответ содержит:

- `scope`, `now`, `profile` — география/текущее время/актуальный личный профиль;
- `summary: {summary, revision, updatedAt}` — краткая общая выжимка;
- `reviewedEvidence[]: {eventId, fingerprint, snapshot, conclusion, summaryRevision, reviewedAt}` — рассмотренные ID и выводы;
- `pendingFeedback[]: {eventId, fingerprint, origin, snapshot, previousConclusion}` — новые или изменённые сигналы, включая архив и снятые реакции;
- `candidates[]: {event, fingerprint}` — будущие карточки «Не оценено», подходящие под стандартный scope.

Snapshot реакции содержит название, описание, категорию, теги, языки, аудиторию, дату, площадку, URL, `reaction`, `favorite`, `notes` и необязательный `dislikeReason` (явная причина отказа). Для `origin=past_events_archive` это данные сохранённого архивного snapshot. `origin=telegram_events` относится к отобранному Telegram-мероприятию; evidence ID имеет префикс `telegram:`, snapshot содержит исходный текст и ссылку на пост. Его состояние доступно через `GET /api/telegram-events/:id` без префикса. Эти реакции обучают общий summary, но Telegram-карточки остаются вне canonical candidates. AI-поля исключены из feedback fingerprint, поэтому новое AI-решение не считается новым человеческим сигналом. Изменение/очистка причины требует пересмотра; пустое поле не меняет прежние fingerprints. `reviewedEvidence` — прежний учтённый snapshot; изменения представлены отдельно в `pendingFeedback`.

При необходимости исходный контекст активной карточки: `GET /api/entities/:id` (в том числе provenance). Архивный snapshot не имеет активного endpoint карточки; для анализа реакции использовать возвращённый feedback snapshot, URL и ранее сохранённый вывод.

## Нейтральный пропуск дубля

```http
PATCH /api/entities/ID
Content-Type: application/json

{"skipped":true,"skipReason":"дубль"}
```

Для Telegram использовать `PATCH /api/telegram-events/ID` с тем же payload (ID без префикса `telegram:`). GET карточки и personal-state PATCH возвращают `skipped` и `skipReason`; mutation нужно подтвердить по ответу. Migration 026 хранит эти поля отдельно в обеих таблицах. `skipReason` — строка до 2000 символов с trim; пустая строка очищает причину. `skipped=true` снимает реакцию, like/dislike снимает skipped; звёздочка остаётся независимой. `skipped=false` возвращает карточку в «Не оценено», если нет реакции или звёздочки. Sync/import и архив сохраняют пропуск и причину. Эти поля не входят в feedback snapshots/fingerprints; skipped-карточки не входят в candidates. Снятие ранее учтённой реакции требует убрать старый сигнал, но не создаёт отрицательного предпочтения. Причина пропуска не является `dislikeReason`.

## Сохранение summary

```http
PUT /api/ai-events-review/summary
Content-Type: application/json

{
  "expectedRevision": 0,
  "summary": "Нравятся …; … пока слабый сигнал. Не нравятся …",
  "evidence": [
    {
      "eventId": "ID из pendingFeedback",
      "fingerprint": "64-символьный fingerprint из pendingFeedback",
      "conclusion": "Что следует из конкретной реакции, с оговоркой о неопределённости."
    }
  ]
}
```

Максимум 500 ID за запрос. Summary — до 5000 символов, индивидуальный вывод — до 2000. Ответ: новая `summary` с увеличенной `revision`. Сохранение summary и evidence атомарно. Нельзя отмечать как рассмотренный ID, которого нет в актуальном pending, или повторять ID в одном пакете. Прежде чем сохранять оценки, обработать весь pending. Если разметки нет, оставить начальную пустую summary и использовать профиль.

## Сохранение AI score

```http
POST /api/ai-events-review/scores?scopeId=belgrade
Content-Type: application/json

{
  "expectedSummaryRevision": 1,
  "scores": [
    {
      "eventId": "ID из candidates[].event.id",
      "fingerprint": "64-символьный fingerprint кандидата",
      "score": 8.5,
      "reason": "Короткое персональное обоснование по-русски.",
      "tags": ["music", "international-artist"]
    }
  ]
}
```

Максимум 100 карточек за запрос. Score — число 0–10, допустимы дробные значения. Ответ — массив актуальных карточек. API меняет только `aiScore`, `aiReason`, `aiTags`, `aiProcessedAt`, `aiDecision`; score от 7 получает `recommended`, остальные — `unknown`. `hidden` автоматически не выставляется. Пользовательские реакции и звёздочки сохраняются независимо. Изменения AI-полей защищены от перезаписи Sync штатными overrides.

До записи API повторно проверяет актуальность карточек и профиля, будущую дату, отсутствие пользовательской оценки и актуальную summary. Fingerprint кандидата включает личный профиль. При появлении нового pending весь пакет отклоняется. Невалидный или устаревший элемент откатывает весь пакет. После успешного пакета перечитать context: fingerprints изменились из-за AI-полей.

Ошибки возвращаются как HTTP 400 `{error}`. Не считать такой ответ успешной записью. Исключения из стандартного набора кандидатов доступны только через штатный `PUT /api/entities/:id`: он требует все canonical-поля, без `id`, `reaction`, `favorite`, `notes`, `archived`, `filtered`, provenance и прочих служебных полей. Получать свежую карточку и брать поля по `GET /api/import/schema`; это путь только для явных пользовательских исключений.

## SQLite

- `ai_event_preference_summary`: singleton `id='main'`, компактный текст `summary`, `revision`, `updatedAt`.
- `ai_event_preference_evidence`: по одному актуальному рассмотренному snapshot на `eventId`, `fingerprint`, `conclusion`, `summaryRevision`, `reviewedAt`. Без FK к active entities, чтобы ID переживали архивацию. Повторная пользовательская разметка заменяет индивидуальный вывод и уточняет общую выжимку.
- `entities`: canonical AI-поля в JSON `data`; личные реакции — отдельные `reaction` / `favorite` / `notes` / `dislikeReason`.
- `telegram_events`: реакции и `dislikeReason` относятся к конкретному отобранному мероприятию, а не каналу; сохраняются при повторном review/import. Migration 024 добавляет поле причины обеим таблицам. PATCH personal-state принимает `dislikeReason` (строка до 2000 символов, пробелы по краям убираются); пустая строка очищает причину. Поле сохраняется независимо от реакции, но AI-review учитывает его как отрицательную причину только при текущем дизлайке.
- `past_events_archive`: исходный `entityId` и полный snapshot с личными состояниями.

Миграция `019_ai_event_preferences.sql` создаёт summary и evidence. `020_ai_score_ten_point_scale.sql` один раз переводит прежние оценки из 0–100 в 0–10, включая overrides и архив. Новые оценки всегда 0–10.

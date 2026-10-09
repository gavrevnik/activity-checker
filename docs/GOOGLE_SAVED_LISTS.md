# Google Places MCP и списки Google Takeout

**Текущий режим: Takeout отложен владельцем.** Блок импорта скрыт, списки не участвуют в новизне. Используются только ресторанные карточки Activity Checker. Разделы об импорте ниже сохранены на будущее.


## Ежедневная квота MCP

`npm run google-places:mcp` использует прежний `GOOGLE_PLACES_API_KEY` Activity Checker. Claw получает тот же ключ через существующий launcher, без копии в исходниках. Счётчик MCP общий для экземпляров Codex/Claw на этой машине: `../data/activity-checker/.mcp-private/google-places.sqlite` (относительно `ACTIVITY_DB`, если он задан). Лимит фиксирован в коде: **100 запросов в сутки Europe/Belgrade**, вместе для Basic/Text Search Essentials IDs Only и Pro. Старые дни хранятся для аудита, но в остатке учитывается только текущий день. Atomic `BEGIN IMMEDIATE` сериализует конкурирующие резервации.

Перед каждым новым live запуском агент читает `google_places_status`, сообщает used/remaining и спрашивает максимум запросов на этот запуск. Явное число в текущем запросе пользователя уже задаёт бюджет. Нужен `maxRequests` от 1 до 100; фактический максимум — min(maxRequests, сегодняшний остаток). Можно потратить меньше. Лимит проверяется перед каждым HTTP, discovery останавливается с частичными результатами; IDs-only и Pro вместе расходуют бюджет. Ошибки, прерванные запросы и резервации перед сбоем учитываются консервативно, не возвращаются. Redirects и автоматические retries отсутствуют. Статус, чтение списков, dry-run и LLM ratings не вызывают Google API.

MCP не предоставляет Enterprise и не принимает произвольные field masks. Pro возвращает название, адрес, гео, типы, business status и Maps URI; API рейтинг, отзывы, телефоны, сайт и часы работы не запрашиваются. Остаётся прежний дополнительный месячный локальный Pro-лимит Activity Checker. Суточный лимит покрывает именно MCP, не прямые обращения UI/других сервисов к ключу. Google project/SKU квоты и биллинг общие с Activity Checker; локальная SQLite не видит внешний расход того же Cloud-проекта и не заменяет бюджет в Cloud Console.

В Claw файл quota закрыт от `life_stack` и Gateway профилями Seatbelt и проверкой пути. Только research worker имеет доступ. Рабочий исходник MCP и защищённая runtime-копия используют одинаковые обработчики, отдельного Places API сервиса нет. После изменения исходников runtime обновляется административно.

## Takeout: выгрузка и импорт

Для Google-аккаунта из Сербии Data Portability API недоступен по опубликованному Google списку стран. Вместо него используется [Google Takeout](https://takeout.google.com/):

1. «Отменить выбор» / Deselect all.
2. Выбрать **«Сохранённое» / Saved**. При необходимости Starred Places добавить **«Карты (ваши места)» / Maps (your places)**. Не выбирать историю передвижений/все продукты.
3. Следующий шаг → однократный экспорт → ZIP. Дождаться ссылки и скачать архив на Mac.
4. Activity Checker → Источники → **Списки Google · Takeout** → выбрать ZIP. Можно импортировать отдельные CSV из архива или Maps GeoJSON.
5. Проверить показанные списки и количество записей. Для обновления повторить импорт новой выгрузки.

Архив не записывается на диск: bounded memory → фиксированный Python stdlib parser → SQLite. В базе сохраняется индекс, а не сырые файлы. Лимиты: ZIP/CSV/JSON до 50 МБ, максимум 50 МБ выбранных распакованных CSV/JSON, 10 МБ на файл внутри ZIP, 5000 ZIP entries, 20 000 записей. Зашифрованные архивы, symlink/path traversal и чрезмерное сжатие отклоняются; ничего не извлекается в файловую систему. Неудачный импорт не меняет прежний индекс. Неизвестные форматы не считаются успешно импортированными.

CSV сохраняет имя списка из имени файла, описание коллекции (если есть), title, note, item_content_url/URL, tags (через `;`) и comment. Maps GeoJSON дополнительно может содержать адрес и координаты. Из Maps URL извлекаются place_id и CID, если они присутствуют. Экспорт не гарантирует place_id, адрес, рейтинг или часы работы. Наличие Maps URL не означает, что его можно преобразовать в Places ID без API-запроса. Пользовательские изображения не импортируются.

Повторный импорт обновляет совпавшие записи. Индекс объединяет все импортированные списки и не забывает ранее знакомые места, даже если их удалили из следующей выгрузки. Place-карточки автоматически не создаются. Таблицы `google_saved_imports`/`google_saved_items` находятся в существующей `activity.sqlite` (миграция 028).

`google_saved_lists` читает индекс без API. `google_places_discovery_batch` исключает Activity Place-карточки и сохранённые Google места; `google_places_text_search_pro`/`ids` по умолчанию имеют `newOnly=true`. Для конкретного обогащения уже известного места можно явно использовать `newOnly=false`. Сопоставление: Places ID → CID/Maps URL → точное нормализованное название. Последнее консервативно и может исключить тёзок; неполный/устаревший индекс не позволяет гарантировать полную новизну. Агент обязан сообщить это в чате.

## Data Portability API на будущее

OAuth не нужен для Takeout и не настроен этим изменением. Если аккаунт станет поддерживаемым, потребуется отдельный OAuth workflow: включить Data Portability API в Cloud Console, создать OAuth client, запросить только `https://www.googleapis.com/auth/dataportability.saved.collections`, без email/openid и без `include_granted_scopes=true`. `maps.starred_places` и `maps.aliased_places` — отдельные restricted scopes. Это потребует отдельной интеграции OAuth/export jobs; здесь реализован Takeout-эквивалент, согласованный после проверки региона.

Источники: [доступность по странам](https://support.google.com/accounts/answer/14452558), [Saved schema](https://developers.google.com/data-portability/schema-reference/save), [Maps schema](https://developers.google.com/data-portability/schema-reference/maps), [OAuth ограничения](https://developers.google.com/data-portability/user-guide/configure-oauth), [Places field tiers](https://developers.google.com/maps/documentation/places/web-service/data-fields).

## Бэкап

Индекс включается в прежний бэкап `activity.sqlite`. **Добавьте новый `data/activity-checker/.mcp-private/google-places.sqlite` в `life-stack-backups/config.json`**, учитывая путь и sidecars. Он не содержит API key или OAuth tokens. Автоматическая отправка данных не включается.

Текущий режим по решению владельца: Google Takeout отложен, блок импорта скрыт. MCP исключает только существующие карточки ресторанов Activity Checker по place_id, CID/Maps URL и нормализованному названию; индекс выгрузок и одна лишь история discovery не используются. Лимиты 100/день и maxRequests сохранены. Код импорта и данные сохранены для возможного возвращения к Takeout.

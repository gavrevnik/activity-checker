import { planned } from "../types.js";
export default planned({
  id: "belgrade-beat",
  name: "Belgrade Beat",
  group: "Местные афиши",
  providerType: "Website/Aggregator",
  mode: "ingestion",
  supportedEntityTypes: ["Event"],
  supportedScopes: ["belgrade"],
  defaultUrl: "https://belgrade-beat.com/events/today",
  credentials: [],
  description: "Автосбор недоступен: сайт отклоняет серверные запросы.",
  setupMessage:
    "Belgrade Beat возвращает HTTP 403. Автоматическое подключение пока недоступно; регистрация и ключ не нужны.",
  docs: [
    {
      label: "Афиша Belgrade Beat",
      url: "https://belgrade-beat.com/events/today",
    },
  ],
  steps: [
    "Регистрация не нужна. При проверке 25.09.2026 серверный запрос получил HTTP 403.",
    "Автосбор отключён до появления доступного способа чтения и отдельного адаптера сайта.",
    "Пока можно открыть афишу по ссылке и добавить выбранное событие вручную или через JSON-импорт.",
  ],
  limitations:
    "Общий JSON-LD reader для этого сайта не подтверждён. HTTP 403 не означает, что нужно завести аккаунт. Проверка и синхронизация отключены; просмотр сайта в браузере может работать.",
});

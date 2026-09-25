import { defineProvider } from "./types.js";
import { entitySchema } from "../../shared/model.js";
export const manual = defineProvider(
  {
    id: "manual",
    name: "Ручной ввод / External LLM",
    group: "Свои источники",
    providerType: "Manual",
    supportedEntityTypes: ["Event", "Place", "Community", "Organizer"],
    supportedScopes: ["*"],
    implemented: true,
    mode: "manual",
    description: "Форма или JSON из внешнего поиска и чата.",
    credentials: [],
    docs: [{ label: "JSON Schema", url: "/api/import/schema" }],
    steps: [
      "Добавьте запись через «Добавить» или откройте «Импорт JSON».",
      "Вставьте результат внешнего исследования, проверьте предпросмотр и импортируйте.",
    ],
    limitations:
      "Встроенного LLM нет. Факты и ссылки из внешнего поиска требуют проверки.",
  },
  {
    async testConnection() {
      return "Локальный импорт доступен";
    },
    async sync() {
      throw new Error("Используйте форму добавления или JSON-импорт.");
    },
    normalize(item) {
      return entitySchema.parse(item.payload);
    },
  },
);

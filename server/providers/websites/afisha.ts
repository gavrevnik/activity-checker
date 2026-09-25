import { structuredProvider } from "../structured.js";
export default structuredProvider({
  id: "afisha",
  name: "Afisha.rs",
  group: "Местные афиши",
  supportedEntityTypes: ["Event"],
  supportedScopes: ["belgrade"],
  defaultUrl: "https://afisha.rs/",
  description: "Русскоязычная афиша Белграда · события с главной страницы.",
  docs: [{ label: "Открыть Afisha.rs", url: "https://afisha.rs/ru" }],
  steps: [
    "Регистрация и API-ключ не нужны. URL: https://afisha.rs/; география: Белград.",
    "Включите → «Проверить» → «Синхронизировать». Загружается подборка с указанной страницы.",
  ],
  limitations:
    "Подтверждено чтение JSON-LD главной страницы: это небольшая подборка, а не полная афиша сайта. Категории, дополнительные страницы и тексты карточек не обходятся; даты могут быть без времени. При изменении разметки потребуется обновление адаптера.",
});

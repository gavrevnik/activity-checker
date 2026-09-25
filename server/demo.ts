import type { Store } from "./store.js";
import type { EntityInput } from "../shared/model.js";
export function seedDemo(store: Store) {
  if (
    store.db
      .prepare("SELECT 1 FROM settings WHERE key='demo-initialized'")
      .get()
  )
    return;
  store.transaction(() => {
    if (!store.entities().length) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 2);
      const day = d.toISOString().slice(0, 10);
      const entities: EntityInput[] = [
        {
          type: "Event",
          title: "Вечер живого джаза",
          description:
            "Демонстрационная запись: камерный концерт в небольшом клубе. Это пример карточки, а не анонс реального события.",
          category: "Музыка",
          startAt: day + "T19:00:00+02:00",
          venue: "Demo Jazz Room",
          address: "Stari grad",
          price: "1 500 RSD",
          tags: ["jazz", "live"],
          languages: ["sr", "en"],
          demo: true,
          externalId: "demo-jazz",
        },
        {
          type: "Place",
          title: "Скалодром у реки",
          description:
            "Демонстрационное место: боулдеринг, вводные занятия и свободные тренировки.",
          category: "Спорт",
          address: "Novi Beograd",
          tags: ["climbing", "indoor"],
          openingHours: "Пн–Вс 10:00–22:00",
          demo: true,
          externalId: "demo-climbing",
        },
        {
          type: "Community",
          title: "Belgrade weekend walks",
          description:
            "Пример международного сообщества для прогулок и знакомства с городом.",
          category: "Общение",
          audience: "international",
          languages: ["en", "ru"],
          tags: ["walking", "expat"],
          demo: true,
          externalId: "demo-walks",
        },
        {
          type: "Organizer",
          title: "Независимая мастерская",
          description:
            "Пример организатора лекций, мастер-классов и небольших выставок.",
          category: "Искусство",
          tags: ["workshops"],
          demo: true,
          externalId: "demo-studio",
        },
      ];
      store.ingest(
        store.source("source-manual"),
        entities.map((e) => ({
          entity: e,
          raw: {
            externalId: e.externalId!,
            url: "",
            rawText: e.description || "",
            payload: e,
          },
        })),
      );
    }
    store.db
      .prepare("INSERT INTO settings VALUES ('demo-initialized','1')")
      .run();
  });
}

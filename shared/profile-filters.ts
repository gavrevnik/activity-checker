import type { FilteringRules, FilterRuleCode } from "./model.js";

// Descriptions always reflect the actual deterministic settings, never a stale copy.
export function profileFilterDescriptions(
  rules: FilteringRules,
): Array<{ code: FilterRuleCode; text: string }> {
  return [
    {
      code: "pastEvents",
      text: "Не показывать завершившиеся события в общей базе. Календарь рекомендаций всегда ограничен выбранным будущим периодом.",
    },
    {
      code: "telegramMinMembers",
      text: `Не включать Telegram-сообщества, где меньше ${rules.telegramMinMembers.minMembers} участников.`,
    },
    {
      code: "ticketsVenue",
      text: `Для Tickets.rs исключать площадки ${rules.ticketsVenue.venues.join(", ") || "(список пуст)"}; слова площадки: ${rules.ticketsVenue.keywords.join(", ") || "нет"}; слова названия: ${rules.ticketsVenue.titleKeywords.join(", ") || "нет"}.`,
    },
    {
      code: "eventTitle",
      text: `Исключать события со словами в названии: ${rules.eventTitle.keywords.join(", ") || "нет"}.`,
    },
    {
      code: "eventLocation",
      text: `Исключать события со словами в месте проведения: ${rules.eventLocation.keywords.join(", ") || "нет"}.`,
    },
    {
      code: "entityTags",
      text: `Исключать карточки с тегами: ${rules.entityTags.keywords.join(", ") || "нет"}.`,
    },
  ];
}

export function disableSampleFilters(rules: FilteringRules): FilteringRules {
  return Object.fromEntries(
    Object.entries(rules).map(([code, value]) => [
      code,
      { ...value, enabled: code === "pastEvents" ? value.enabled : false },
    ]),
  ) as FilteringRules;
}

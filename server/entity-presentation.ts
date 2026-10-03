import type { EntityPresentation, NormalizedEntity } from "../shared/model.js";
import {
  displayDate,
  eventDateRangeLabel,
  localDateTime,
  localDay,
  zone,
} from "../shared/dates.js";
import { containsSerbianSpecificLetters } from "../shared/text.js";

export const presentationVersion = 2;
export function buildEntityPresentation(
  entity: NormalizedEntity,
  timeZone = zone,
): EntityPresentation {
  const day = (value: string) =>
    value ? (value.length === 10 ? value : localDay(value, timeZone)) : "";
  const startDay = day(entity.startAt);
  return {
    version: presentationVersion,
    timeZone,
    startDay,
    endDay: day(entity.endAt) || startDay,
    startHour:
      entity.startAt && entity.startAt.length > 10
        ? Number(localDateTime(entity.startAt, timeZone).slice(11, 13))
        : null,
    dateLabel: eventDateRangeLabel(entity.startAt, entity.endAt, timeZone),
    dayNumber: startDay.slice(8, 10),
    monthLabel: entity.startAt
      ? displayDate(entity.startAt, {
          timeZone: entity.startAt.length === 10 ? "UTC" : timeZone,
          day: undefined,
          month: "short",
        })
      : "",
    searchText: [
      entity.title,
      entity.description,
      entity.cuisine,
      entity.venue,
      entity.address,
      ...entity.tags,
    ]
      .join(" ")
      .toLowerCase(),
    hasSerbianTitle: containsSerbianSpecificLetters(entity.title),
    isRestaurant:
      entity.type === "Place" &&
      entity.tags.some((tag) => tag.toLocaleLowerCase() === "restaurant"),
    memberCountLabel:
      entity.memberCount === null
        ? "Размер неизвестен"
        : `${entity.memberCount.toLocaleString("ru-RU")} участников`,
    googleReviewCountLabel:
      entity.googleReviewCount === null
        ? ""
        : entity.googleReviewCount.toLocaleString("ru-RU"),
  };
}

import { z } from "zod";
import { digestItemSchema } from "./ai-digests.js";
import { localDay } from "./dates.js";

export const recommendationGroups = [
  "sport",
  "walks",
  "social",
  "concerts",
] as const;
export type RecommendationGroup = (typeof recommendationGroups)[number];
export const groupLabels: Record<RecommendationGroup, string> = {
  sport: "Спортивные активности",
  walks: "Прогулки",
  social: "Социальные события",
  concerts: "Концерты и фестивали",
};
export const defaultRecommendationPrompts = {
  sport:
    "Ищи падел и сквош для новичков, бег и велосипедные активности в Белграде и окрестностях. Проверяй доступность новичкам, дату, время, место, регистрацию и формат участия. Предпочитай совместные тренировки и возможность познакомиться с людьми.",
  walks:
    "Ищи хайкинг, трекинг, групповые прогулки и посещение интересных мест на природе рядом с Белградом. Проверяй маршрут, сложность, место и время встречи, транспорт и регистрацию. В Afisha.rs исключай раздел «Экскурсии»: массовые обзорные туры не подменяют природные прогулки.",
  social:
    "Приоритет — возможность общаться и участвовать в группе: разговорные клубы, караоке, совместные занятия и встречи для знакомства. Простое посещение стендапа не является социальным событием. Учитывай профиль и feedback-summary из ai-events-review; квизы и настолки сохраняют низкий приоритет. Проверяй язык общения и возможность прийти одному.",
  concerts:
    "Ищи музыкальные концерты, стендапы известных персон, творческие встречи и фестивали, включая музыкальные, гастрономические и фестивали еды. Предлагай русскоязычных и международных исполнителей; исключай музыкальную и разговорную программу на балканских языках. Определяй язык по подтверждённой программе, а не по национальности или названию. Гастрономические и другие фестивали, доступные без знания языка, не исключай за местное происхождение: оценивай содержание, участие и интерес по профилю. Выше ранжируй известных и интересных мне исполнителей по актуальному музыкальному профилю и ai-events-review. Если язык существенно влияет на отбор и не подтверждён, уточни оригинал до рекомендации.",
};
const prompt = z.string().trim().min(1).max(12000);
export const recommendationPromptsSchema = z
  .object({ sport: prompt, walks: prompt, social: prompt, concerts: prompt })
  .strict();
export type RecommendationPrompts = z.output<
  typeof recommendationPromptsSchema
>;
export type RecommendationSettings = {
  revision: number;
  prompts: RecommendationPrompts;
};
export type RecommendationSearchSource = {
  id: string;
  name: string;
  url: string;
  description: string;
  method: "telegram" | "aggregator" | "web" | "snapshot";
  enabled: boolean;
};
export type RecommendationSourcesView = {
  telegram: RecommendationSearchSource[];
  other: RecommendationSearchSource[];
  additional: RecommendationSearchSource[];
  knowledgeRevision: string | null;
  warning: string | null;
};
export const recommendationItemSchema = digestItemSchema.safeExtend({
  group: z.enum(recommendationGroups),
});
export type RecommendationItem = z.output<typeof recommendationItemSchema>;
// Personal entries are never part of an LLM publication or its prompt groups.
export const calendarGroups = [...recommendationGroups, "personal"] as const;
export type CalendarGroup = (typeof calendarGroups)[number];
export const calendarGroupLabels = { ...groupLabels, personal: "Мои события" };
export const personalRecommendationInputSchema = z
  .object({
    id: z.uuid(),
    scopeId: z.string().min(1),
    day: z.iso.date(),
    hour: z.number().int().min(0).max(23),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(10000).default(""),
  })
  .strict();
export type PersonalRecommendation = {
  id: string;
  group: "personal";
  title: string;
  description: string;
  startAt: string;
  endAt: "";
  sourceName: string;
  sourceUrl: "";
  eventUrl: "";
  weekEndDate: string;
  deletedAt: string | null;
  favorite: boolean;
};
export type CalendarRecommendation =
  RecommendationItem | PersonalRecommendation;

// Minimal identity is enough before relevance scoring; additional candidate fields survive filtering.
const candidateDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const candidateUrl = z.url().refine((value) => /^https?:\/\//i.test(value));
export const recommendationCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    sourceName: z.string().trim().min(1).max(300),
    sourceUrl: candidateUrl,
    eventUrl: z.union([candidateUrl, z.literal("")]).default(""),
    startAt: candidateDate,
    endAt: z.union([candidateDate, z.literal("")]).default(""),
  })
  .passthrough();
export type RecommendationCandidate = z.output<
  typeof recommendationCandidateSchema
>;
export type HiddenRecommendation = {
  id: string;
  item: RecommendationItem;
  hiddenAt: string;
};
export const recommendationInputSchema = z
  .object({
    id: z.uuid(),
    scopeId: z.string().min(1),
    kind: z.enum(["week", "concerts-2026"]),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    requestSummary: z.string().trim().min(1).max(3000),
    notes: z.string().trim().max(10000).default(""),
    items: z.array(recommendationItemSchema).max(500),
    settingsRevision: z.number().int().min(0),
    expectedSnapshotId: z.uuid().nullable(),
  })
  .strict()
  .refine((d) => d.endDate >= d.startDate, "Неверный период рекомендаций");
export type RecommendationInput = z.output<typeof recommendationInputSchema>;
export type RecommendationSnapshot = RecommendationInput & {
  updatedAt: string;
};
export type RecommendationsView = {
  settings: RecommendationSettings;
  snapshot: RecommendationSnapshot | null;
  period: { startDate: string; endDate: string };
  timeZone: string;
  hidden: HiddenRecommendation[];
  favorites: FavoriteRecommendation[];
  personal: PersonalRecommendation[];
};
export type FavoriteRecommendation = {
  id: string;
  item: RecommendationItem;
  addedAt: string;
};

const identityText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const identityUrl = (value: string) => {
  if (!value) return "";
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.protocol = "https:";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
};
export function recommendationIdentityKeys(
  item: RecommendationCandidate | CalendarRecommendation,
  timeZone: string,
) {
  if ("group" in item && item.group === "personal" && "id" in item)
    return [`personal:${item.id}`];
  const day = recommendationDay(item.startAt, timeZone);
  const title = identityText(item.title);
  const url = new URL(item.sourceUrl);
  const channel = /^(?:www\.)?(?:t\.me|telegram\.me)$/i.test(url.hostname)
    ? url.pathname
        .split("/")
        .filter(Boolean)
        .filter((part) => part !== "s")[0]
        ?.toLowerCase()
    : null;
  const keys = [
    JSON.stringify([day, "name", title, identityText(item.sourceName)]),
  ];
  keys.push(
    JSON.stringify([
      day,
      "source",
      title,
      channel ? `telegram:${channel}` : identityUrl(item.sourceUrl),
    ]),
  );
  if (item.eventUrl) {
    const telegram = /^(?:www\.)?(?:t\.me|telegram\.me)$/i.test(
      new URL(item.eventUrl).hostname,
    );
    keys.push(
      JSON.stringify([
        day,
        "event",
        identityUrl(item.eventUrl),
        telegram ? title : "",
      ]),
    );
  }
  return keys;
}
export function remainingWeek(today: string) {
  const date = new Date(`${today}T12:00:00Z`);
  const days = [];
  const remaining = 7 - ((date.getUTCDay() + 6) % 7);
  for (let i = 0; i < remaining; i++) {
    days.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return days;
}
export function recommendationPeriod(
  kind: RecommendationInput["kind"],
  today: string,
) {
  return kind === "week"
    ? { startDate: today, endDate: remainingWeek(today).at(-1)! }
    : { startDate: "2026-01-01", endDate: "2026-12-31" };
}
export function recommendationTime(
  item: CalendarRecommendation,
  _day: string,
  timeZone: string,
) {
  if (item.startAt.length === 10) return "Время уточняется";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(item.startAt));
}
export const recommendationDay = (value: string, timeZone: string) =>
  value.length === 10 ? value : localDay(value, timeZone);
export function recommendationSlots(
  items: CalendarRecommendation[],
  timeZone: string,
) {
  const slots = new Map<
    string,
    { day: string; hour: number; items: CalendarRecommendation[] }
  >();
  for (const item of items) {
    const day = recommendationDay(item.startAt, timeZone);
    const hour =
      item.startAt.length === 10
        ? -1
        : Number(recommendationTime(item, day, timeZone).slice(0, 2));
    const key = `${day}:${hour}`;
    const slot = slots.get(key) || { day, hour, items: [] };
    slot.items.push(item);
    slots.set(key, slot);
  }
  return [...slots.values()]
    .sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour)
    .map((slot) => ({
      ...slot,
      items: slot.items.sort(
        (a, b) =>
          Date.parse(a.startAt) - Date.parse(b.startAt) ||
          ("aiScore" in b ? b.aiScore : 0) - ("aiScore" in a ? a.aiScore : 0),
      ),
    }));
}
export function recommendationExpired(
  item: CalendarRecommendation,
  now: Date,
  timeZone: string,
) {
  if (item.group === "personal")
    return item.weekEndDate < localDay(now, timeZone);
  const end = item.endAt || item.startAt;
  return end.length === 10
    ? end < localDay(now, timeZone)
    : Date.parse(end) < now.valueOf();
}
export function recommendationsOnDay(
  items: CalendarRecommendation[],
  day: string,
  timeZone: string,
) {
  return items
    .filter((item) => recommendationDay(item.startAt, timeZone) === day)
    .sort(
      (a, b) =>
        Date.parse(a.startAt) - Date.parse(b.startAt) ||
        ("aiScore" in b ? b.aiScore : 0) - ("aiScore" in a ? a.aiScore : 0),
    );
}

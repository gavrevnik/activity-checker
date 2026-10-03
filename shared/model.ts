import { z } from "zod";

export const entityTypes = ["Event", "Place", "Community"] as const;
export type EntityType = (typeof entityTypes)[number];
export const typeLabels: Record<EntityType, string> = {
  Event: "События",
  Place: "Места",
  Community: "Сообщества",
};
export const categories = [
  "Музыка",
  "Искусство",
  "Спорт",
  "Прогулки",
  "Еда и напитки",
  "Обучение",
  "Игры",
  "Общение",
  "Кино",
  "Другое",
];
const text = z.string().trim().max(20000);
export const httpUrl = z
  .string()
  .trim()
  .max(3000)
  .refine(
    (v) =>
      !v ||
      (/^https?:\/\//i.test(v) &&
        (() => {
          try {
            const u = new URL(v);
            return !u.username && !u.password;
          } catch {
            return false;
          }
        })()),
    "Нужна ссылка http:// или https:// без логина и пароля",
  );
const date = z.union(
  [z.literal(""), z.iso.date(), z.iso.datetime({ offset: true })],
  { error: "Дата: YYYY-MM-DD или ISO 8601 с часовым поясом" },
);
export const entitySchema = z
  .object({
    type: z.enum(entityTypes),
    title: text.min(1).max(400),
    description: text.default(""),
    country: z
      .string()
      .trim()
      .length(2)
      .transform((v) => v.toUpperCase())
      .default("RS"),
    city: z.string().trim().max(160).default("Belgrade"),
    category: z.string().trim().max(160).default("Другое"),
    rawCategory: text.default(""),
    cuisine: z.string().trim().max(300).default(""),
    tags: z.array(z.string().trim().max(80)).max(50).default([]),
    languages: z.array(z.string().trim().max(40)).max(20).default([]),
    audience: z
      .enum(["all", "russian-speaking", "international", "local"])
      .default("all"),
    startAt: date.default(""),
    endAt: date.default(""),
    venue: text.default(""),
    address: text.default(""),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    url: httpUrl.default(""),
    website: httpUrl.default(""),
    imageUrl: httpUrl.default(""),
    phone: z.string().max(100).default(""),
    price: z.string().max(300).default(""),
    openingHours: text.default(""),
    googleRating: z.number().min(0).max(5).nullable().default(null),
    googleReviewCount: z.number().int().min(0).nullable().default(null),
    googleRatingSource: text.default(""),
    googleRatingCheckedAt: date.nullable().default(null),
    memberCount: z.number().int().min(0).nullable().default(null),
    externalId: z.string().trim().max(500).optional(),
    knownIds: z.record(z.string().max(80), z.string().max(500)).default({}),
    demo: z.boolean().default(false),
    aiScore: z.number().min(0).max(10).nullable().default(null),
    aiDecision: z.enum(["unknown", "recommended", "hidden"]).default("unknown"),
    aiReason: text.nullable().default(null),
    aiTags: z.array(z.string()).max(50).default([]),
    aiProcessedAt: date.nullable().default(null),
  })
  .strict()
  .refine(
    (v) =>
      !v.endAt || !v.startAt || Date.parse(v.endAt) >= Date.parse(v.startAt),
    "Конец события раньше начала",
  );
export type EntityInput = z.input<typeof entitySchema>;
export type NormalizedEntity = z.output<typeof entitySchema>;
export const entityReactions = ["", "like", "dislike"] as const;
export type EntityReaction = (typeof entityReactions)[number];
export interface EntityPresentation {
  version: number;
  timeZone: string;
  startDay: string;
  endDay: string;
  startHour: number | null;
  dateLabel: string;
  dayNumber: string;
  monthLabel: string;
  searchText: string;
  hasSerbianTitle: boolean;
  isRestaurant: boolean;
  memberCountLabel: string;
  googleReviewCountLabel: string;
}
export interface Entity extends NormalizedEntity {
  presentation: EntityPresentation;
  id: string;
  archived: boolean;
  favorite: boolean;
  reaction: EntityReaction;
  dislikeReason: string;
  skipped: boolean;
  skipReason: string;
  notes: string;
  filtered: boolean;
  filterReasons: FilterRuleCode[];
  createdAt: string;
  updatedAt: string;
  sources: { id: string; name: string; providerId: string }[];
  duplicateCount: number;
}
export const importSchema = z
  .object({
    version: z.literal(1).default(1),
    entities: z.array(entitySchema).min(1).max(1000),
  })
  .strict();
export const sourceSchema = z
  .object({
    providerId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    url: httpUrl.default(""),
    scopeId: z.string().min(1).default("belgrade"),
    language: z.string().max(50).default(""),
    audience: z
      .enum(["all", "russian-speaking", "international", "local"])
      .default("all"),
    categories: z.array(z.string()).max(30).default([]),
    enabled: z.boolean().default(false),
    priority: z.number().int().min(0).max(100).default(50),
    notes: z.string().max(5000).default(""),
    format: z.enum(["auto", "json", "jsonld", "rss", "ics"]).default("auto"),
    keyword: z.string().max(6500).default(""),
    minRating: z.number().min(0).max(5).multipleOf(0.5).default(4),
  })
  .strict();
export type SourceInput = z.input<typeof sourceSchema>;
export interface Source extends z.output<typeof sourceSchema> {
  id: string;
  status: string;
  lastSyncAt: string | null;
  lastTestAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastResult: SyncResult | null;
}
export interface Scope {
  id: string;
  name: string;
  country: string;
  city: string | null;
  timezone: string;
  osmAreaId: number | null;
}
export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  duplicates: number;
  filtered: number;
  errors: number;
  warnings: string[];
  runId?: string;
}
export const filterRuleCodes = [
  "pastEvents",
  "telegramMinMembers",
  "ticketsVenue",
  "eventTitle",
  "eventLocation",
  "entityTags",
] as const;
export type FilterRuleCode = (typeof filterRuleCodes)[number];
const filterTermsSchema = z.array(z.string().trim().min(1).max(300)).max(100);
export const filteringRulesSchema = z
  .object({
    pastEvents: z.object({ enabled: z.boolean() }).strict(),
    telegramMinMembers: z
      .object({
        enabled: z.boolean(),
        minMembers: z.number().int().min(0).max(10_000_000),
      })
      .strict(),
    ticketsVenue: z
      .object({
        enabled: z.boolean(),
        venues: filterTermsSchema,
        keywords: filterTermsSchema,
        titleKeywords: filterTermsSchema.default([]),
      })
      .strict(),
    eventTitle: z
      .object({ enabled: z.boolean(), keywords: filterTermsSchema })
      .strict(),
    eventLocation: z
      .object({ enabled: z.boolean(), keywords: filterTermsSchema })
      .strict(),
    entityTags: z
      .object({ enabled: z.boolean(), keywords: filterTermsSchema })
      .strict()
      .default({ enabled: true, keywords: ["#For kids"] }),
  })
  .strict();
export type FilteringRules = z.output<typeof filteringRulesSchema>;
export const defaultFilteringRules: FilteringRules = {
  pastEvents: { enabled: true },
  telegramMinMembers: { enabled: true, minMembers: 200 },
  ticketsVenue: {
    enabled: true,
    venues: ["Pan Teatar", "Opera i teatar Madlenianum", "Teatar Odeon"],
    keywords: ["pozorište"],
    titleKeywords: ["FEST 2026"],
  },
  eventTitle: { enabled: true, keywords: ["tribute", "Vaučer"] },
  eventLocation: { enabled: true, keywords: ["Dečji"] },
  entityTags: { enabled: true, keywords: ["#For kids"] },
};
export interface FilteringRulesView {
  rules: FilteringRules;
  counts: Record<FilterRuleCode, number> & { total: number };
  pastEventsByScope: Record<string, number>;
}
export const telegramOperationValues = [
  "searchPublicChats",
  "channels.searchPosts",
  "messages.searchGlobal",
  "channels.getChannelRecommendations",
] as const;
export type TelegramOperationValue = (typeof telegramOperationValues)[number];
export const syncOptionsSchema = z
  .object({
    confirmed: z.boolean().default(false),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    categories: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    resultsPerQuery: z.number().int().min(1).max(100).optional(),
    maxItems: z.number().int().min(1).max(500).optional(),
    operations: z
      .array(z.enum(telegramOperationValues))
      .min(1)
      .max(4)
      .optional(),
    previewId: z.uuid().optional(),
  })
  .strict();
export type SyncOptions = z.output<typeof syncOptionsSchema>;
export interface SyncPlan {
  sourceId: string;
  providerId: string;
  title: string;
  summary: string;
  requiresConfirmation: boolean;
  expectedRequests: number | null;
  minimumRequests: number;
  maximumRequests: number;
  rowsPerRequest?: number;
  knownItems?: number;
  startDate?: string;
  endDate?: string;
  categories?: string[];
  resultsPerQuery?: number;
  categoryOptions?: { value: string; label: string }[];
  operations?: TelegramOperationValue[];
  operationOptions?: { value: TelegramOperationValue; label: string }[];
  parameters: { label: string; value: string }[];
  warnings: string[];
  paid?: { maxItems: number; maxChargeUsd: number };
  limits?: { maxItems: number };
  previewId?: string;
  previewExpiresAt?: string;
  exactPages?: number;
  previewRequests?: number;
  requestsAfterConfirmation?: number;
  firstPageReused?: boolean;
}
const profileItem = z.string().trim().min(1).max(500);
export const userProfileSchema = z
  .object({
    summary: z.string().trim().max(5000),
    eventPreferences: z.array(profileItem).max(50),
    communityPreferences: z.array(profileItem).max(50),
    musicPreferences: z.array(profileItem).max(50),
    artists: z.array(z.string().trim().min(1).max(200)).max(200),
  })
  .strict();
export type UserProfileInput = z.input<typeof userProfileSchema>;
export interface UserProfile extends z.output<typeof userProfileSchema> {
  updatedAt: string;
}
export interface Credential {
  key: string;
  label: string;
}
export const sourceConfigFields = [
  "scope",
  "url",
  "format",
  "keyword",
  "minRating",
] as const;
export type SourceConfigField = (typeof sourceConfigFields)[number];
export interface ProviderInfo {
  id: string;
  name: string;
  group: string;
  providerType: string;
  supportedEntityTypes: EntityType[];
  supportedScopes: string[];
  implemented: boolean;
  mode: "ingestion" | "manual" | "discovery" | "enrichment";
  description: string;
  configFields: SourceConfigField[];
  credentials: Credential[];
  registration?: { service: string; url: string };
  setupMessage?: string;
  docs: { label: string; url: string }[];
  steps: string[];
  limitations: string;
  defaultUrl?: string;
  manualSyncOnly?: boolean;
  requiresSyncConfirmation?: boolean;
  modelCallable?: boolean;
  mcpServer?: string;
  mcpTools?: { name: string; description: string }[];
  webSearchLlm?: boolean;
  hiddenFromSources?: boolean;
  browserOnly?: boolean;
  otherSource?: boolean;
}
export interface Connection {
  status:
    | "disabled"
    | "not_configured"
    | "setup_required"
    | "ready"
    | "connected"
    | "error";
  message: string;
  credentials: { key: string; present: boolean }[];
  canSync: boolean;
  canTest: boolean;
}
export interface SourceView extends Source {
  connection: Connection;
  provider: ProviderInfo;
  itemCount: number;
  quotaUsage?: {
    sku: "pro";
    used: number;
    limit: number;
    remaining: number;
    billingMonth: string;
  };
  enterpriseQuotaUsage?: {
    sku: "enterprise";
    used: number;
    limit: number;
    remaining: number;
    billingMonth: string;
  };
}
export interface Candidate {
  id: string;
  name: string;
  url: string;
  probableType: string;
  scopeId: string;
  reason: string;
  status: "new" | "accepted" | "ignored";
  discoveredFrom: string;
  entityId: string | null;
}
export interface Provenance {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  externalId: string;
  rawText: string;
  rawPayload: unknown;
  publishedAt: string | null;
  fetchedAt: string;
  checksum: string;
}
export interface EntityDetail extends Entity {
  provenance: Provenance[];
  related: { id: string; title: string; type: EntityType; relation: string }[];
  duplicates: { id: string; title: string; type: EntityType; reason: string }[];
}
export interface SyncRun extends SyncResult {
  id: string;
  sourceId: string;
  sourceName: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  error: string | null;
}

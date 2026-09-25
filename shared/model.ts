import { z } from "zod";

export const entityTypes = [
  "Event",
  "Place",
  "Community",
  "Organizer",
] as const;
export type EntityType = (typeof entityTypes)[number];
export const typeLabels: Record<EntityType, string> = {
  Event: "События",
  Place: "Места",
  Community: "Сообщества",
  Organizer: "Организаторы",
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
    externalId: z.string().trim().max(500).optional(),
    knownIds: z.record(z.string().max(80), z.string().max(500)).default({}),
    demo: z.boolean().default(false),
    aiScore: z.number().min(0).max(100).nullable().default(null),
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
export interface Entity extends NormalizedEntity {
  id: string;
  archived: boolean;
  favorite: boolean;
  notes: string;
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
    keyword: z.string().max(200).default(""),
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
  errors: number;
  warnings: string[];
  runId?: string;
}
export interface Credential {
  key: string;
  label: string;
}
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
  credentials: Credential[];
  registration?: { service: string; url: string };
  setupMessage?: string;
  docs: { label: string; url: string }[];
  steps: string[];
  limitations: string;
  defaultUrl?: string;
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

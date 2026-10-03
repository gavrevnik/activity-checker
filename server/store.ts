import { DatabaseSync } from "node:sqlite";
import { normalizePersonalStatePatch } from "../shared/personal-state.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entitySchema,
  filteringRulesSchema,
  defaultFilteringRules,
  sourceSchema,
  userProfileSchema,
  type Entity,
  type EntityReaction,
  type EntityDetail,
  type EntityInput,
  type FilteringRules,
  type FilteringRulesView,
  type FilterRuleCode,
  type NormalizedEntity,
  type Scope,
  type Source,
  type SourceInput,
  type SyncResult,
  type Candidate,
  type UserProfile,
  type UserProfileInput,
} from "../shared/model.js";
import { isPastEvent, localDay, zone } from "../shared/dates.js";
import {
  buildEntityPresentation,
  presentationVersion,
} from "./entity-presentation.js";
import {
  canonicalUrl,
  digest,
  identityKeys,
  nameKey,
  normalize,
  ticketsSeriesKey,
} from "./normalize.js";
import type { RawItem } from "./providers/types.js";
import { providers, getProvider } from "./providers/registry.js";
import {
  defaultUserProfile,
  upgradeLegacyUserProfile,
  upgradeUserProfileDefaults,
} from "./profile.js";
const now = () => new Date().toISOString();
const result = (): SyncResult => ({
  fetched: 0,
  created: 0,
  updated: 0,
  duplicates: 0,
  filtered: 0,
  errors: 0,
  warnings: [],
});
type Row = Record<string, any>;
const filteringRulesVersion = "4";
const userProfileVersion = "2";
const uniqueTerms = (current: string[], required: string[]) => {
  const seen = new Set<string>();
  return [...current, ...required].filter((term) => {
    const key = nameKey(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const earlierEvent = (a: NormalizedEntity, b: NormalizedEntity) => {
  if (!a.startAt) return b.startAt ? b : a;
  if (!b.startAt) return a;
  return a.startAt.localeCompare(b.startAt) <= 0 ? a : b;
};
const canCollapseEvents = (a: NormalizedEntity, b: NormalizedEntity) =>
  a.type === "Event" &&
  b.type === "Event" &&
  a.country === b.country &&
  a.demo === b.demo &&
  nameKey(a.title) === nameKey(b.title) &&
  nameKey(a.city) === nameKey(b.city) &&
  (!a.startAt ||
    !b.startAt ||
    a.startAt.slice(0, 10) === b.startAt.slice(0, 10) ||
    (Boolean(a.venue) && nameKey(a.venue) === nameKey(b.venue)));

export class Store {
  db: DatabaseSync;
  constructor(path = "../data/activity-checker/activity.sqlite", seed = true) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
    if (seed) this.seed();
    this.upgradeUserProfile();
    this.upgradeFilteringRules();
    this.collapseEventDuplicates();
    this.reapplyFilterRules();
    this.refreshEntityPresentations();
    this.db
      .prepare(
        "UPDATE sync_runs SET status='error',finishedAt=?,errors=errors+1,error='Сервер был остановлен во время синхронизации' WHERE status='running'",
      )
      .run(now());
  }
  migrate() {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)",
    );
    const dir = fileURLToPath(new URL("../migrations", import.meta.url));
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (this.db.prepare("SELECT 1 FROM migrations WHERE name=?").get(file))
        continue;
      this.transaction(() => {
        this.db.exec(readFileSync(resolve(dir, file), "utf8"));
        this.db.prepare("INSERT INTO migrations VALUES (?,?)").run(file, now());
      });
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT operation");
    try {
      const value = fn();
      this.db.exec("RELEASE operation");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK TO operation; RELEASE operation");
      throw e;
    }
  }
  scopes(): Scope[] {
    return this.db.prepare("SELECT * FROM scopes").all() as unknown as Scope[];
  }
  scope(id: string): Scope {
    const s = this.db.prepare("SELECT * FROM scopes WHERE id=?").get(id);
    if (!s) throw new Error("Неизвестная география");
    return s as unknown as Scope;
  }
  profile(): UserProfile {
    const row = this.db
      .prepare("SELECT data,updatedAt FROM user_profile WHERE id='main'")
      .get() as { data: string; updatedAt: string } | undefined;
    if (!row) return this.saveProfile(defaultUserProfile);
    const raw = JSON.parse(row.data);
    const parsed = userProfileSchema.safeParse(raw);
    if (!parsed.success) {
      const upgraded = upgradeLegacyUserProfile(raw);
      if (!upgraded) throw parsed.error;
      return this.saveProfile(upgraded);
    }
    return {
      ...parsed.data,
      updatedAt: row.updatedAt,
    };
  }
  saveProfile(input: UserProfileInput): UserProfile {
    const data = userProfileSchema.parse(input);
    const updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO user_profile (id,data,updatedAt) VALUES ('main',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt",
      )
      .run(JSON.stringify(data), updatedAt);
    return { ...data, updatedAt };
  }
  private upgradeUserProfile() {
    const version = this.db
      .prepare("SELECT value FROM settings WHERE key='user-profile-version'")
      .get() as { value: string } | undefined;
    if (version?.value === userProfileVersion) return;
    const { updatedAt: _updatedAt, ...profile } = this.profile();
    const upgraded = upgradeUserProfileDefaults(profile);
    if (upgraded !== profile) this.saveProfile(upgraded);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('user-profile-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(userProfileVersion);
  }
  filterRules(): FilteringRules {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='filtering-rules'")
      .get() as { value: string } | undefined;
    if (!row) return defaultFilteringRules;
    try {
      const raw = JSON.parse(row.value);
      const parsed = filteringRulesSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      const legacyVenue = raw?.ticketsVenue?.venue;
      if (typeof legacyVenue !== "string") return defaultFilteringRules;
      const keepLegacyVenue =
        legacyVenue.trim() &&
        !nameKey(legacyVenue).includes(nameKey("pozorište"));
      return filteringRulesSchema.parse({
        ...defaultFilteringRules,
        pastEvents: raw.pastEvents,
        telegramMinMembers: raw.telegramMinMembers,
        ticketsVenue: {
          enabled: raw.ticketsVenue.enabled,
          venues: [
            ...defaultFilteringRules.ticketsVenue.venues,
            ...(keepLegacyVenue ? [legacyVenue.trim()] : []),
          ],
          keywords: defaultFilteringRules.ticketsVenue.keywords,
          titleKeywords: defaultFilteringRules.ticketsVenue.titleKeywords,
        },
      });
    } catch {
      return defaultFilteringRules;
    }
  }
  private upgradeFilteringRules() {
    const version = this.db
      .prepare("SELECT value FROM settings WHERE key='filtering-rules-version'")
      .get() as { value: string } | undefined;
    if (version?.value === filteringRulesVersion) return;
    const rules = this.filterRules();
    const upgraded = filteringRulesSchema.parse({
      ...rules,
      ticketsVenue: {
        ...rules.ticketsVenue,
        venues: uniqueTerms(
          rules.ticketsVenue.venues,
          defaultFilteringRules.ticketsVenue.venues,
        ),
        keywords: uniqueTerms(
          rules.ticketsVenue.keywords,
          defaultFilteringRules.ticketsVenue.keywords,
        ),
        titleKeywords: uniqueTerms(
          rules.ticketsVenue.titleKeywords,
          defaultFilteringRules.ticketsVenue.titleKeywords,
        ),
      },
      eventTitle: {
        ...rules.eventTitle,
        keywords: uniqueTerms(
          rules.eventTitle.keywords,
          defaultFilteringRules.eventTitle.keywords,
        ),
      },
      eventLocation: {
        ...rules.eventLocation,
        keywords: uniqueTerms(
          rules.eventLocation.keywords,
          defaultFilteringRules.eventLocation.keywords,
        ),
      },
      entityTags: {
        ...rules.entityTags,
        keywords: uniqueTerms(
          rules.entityTags.keywords,
          defaultFilteringRules.entityTags.keywords,
        ),
      },
    });
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES ('filtering-rules',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(upgraded));
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES ('filtering-rules-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(filteringRulesVersion);
    });
  }
  filterRulesView(): FilteringRulesView {
    const counts: FilteringRulesView["counts"] = {
      total: 0,
      pastEvents: 0,
      telegramMinMembers: 0,
      ticketsVenue: 0,
      eventTitle: 0,
      eventLocation: 0,
      entityTags: 0,
    };
    const rows = this.db
      .prepare("SELECT filterReason FROM entities WHERE filtered=1")
      .all() as Array<{ filterReason: string }>;
    counts.total = rows.length;
    for (const row of rows)
      for (const code of JSON.parse(row.filterReason) as FilterRuleCode[])
        if (code in counts) counts[code]++;
    const scopes = this.scopes();
    const pastEventsByScope = Object.fromEntries(
      scopes.map((scope) => [scope.id, 0]),
    ) as Record<string, number>;
    const events = this.db
      .prepare("SELECT country,city,data FROM entities WHERE type='Event'")
      .all() as Array<{ country: string; city: string; data: string }>;
    for (const row of events) {
      const event = entitySchema.parse(JSON.parse(row.data));
      if (event.demo) continue;
      for (const scope of scopes) {
        if (
          row.country === scope.country &&
          (!scope.city || row.city === scope.city) &&
          isPastEvent(
            event.startAt,
            event.endAt,
            localDay(new Date(), scope.timezone),
            scope.timezone,
          )
        )
          pastEventsByScope[scope.id]++;
      }
    }
    return { rules: this.filterRules(), counts, pastEventsByScope };
  }
  saveFilterRules(input: FilteringRules): FilteringRulesView {
    const rules = filteringRulesSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('filtering-rules',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(rules));
    this.reapplyFilterRules();
    return this.filterRulesView();
  }
  private filterReasons(
    data: NormalizedEntity,
    providerIds: string[],
    timezone: string,
  ): FilterRuleCode[] {
    const rules = this.filterRules();
    const reasons: FilterRuleCode[] = [];
    if (
      rules.pastEvents.enabled &&
      data.type === "Event" &&
      isPastEvent(
        data.startAt,
        data.endAt,
        localDay(new Date(), timezone),
        timezone,
      )
    )
      reasons.push("pastEvents");
    const telegram =
      providerIds.includes("telegram") ||
      data.tags.includes("telegram") ||
      Boolean(data.knownIds.telegram || data.knownIds.telegram_channel);
    if (
      rules.telegramMinMembers.enabled &&
      data.type === "Community" &&
      telegram &&
      data.memberCount !== null &&
      data.memberCount < rules.telegramMinMembers.minMembers
    )
      reasons.push("telegramMinMembers");
    const ticketVenue = nameKey(data.venue);
    const exactTicketVenues = rules.ticketsVenue.venues
      .map(nameKey)
      .filter(Boolean);
    const ticketKeywords = rules.ticketsVenue.keywords
      .map(nameKey)
      .filter(Boolean);
    const ticketTitleKeywords = rules.ticketsVenue.titleKeywords
      .map(nameKey)
      .filter(Boolean);
    const ticketTitle = nameKey(data.title);
    if (
      rules.ticketsVenue.enabled &&
      data.type === "Event" &&
      providerIds.includes("tickets") &&
      ((ticketVenue && exactTicketVenues.includes(ticketVenue)) ||
        ticketKeywords.some((keyword) => ticketVenue.includes(keyword)) ||
        ticketTitleKeywords.some((keyword) => ticketTitle.includes(keyword)))
    )
      reasons.push("ticketsVenue");
    const title = nameKey(data.title);
    if (
      rules.eventTitle.enabled &&
      data.type === "Event" &&
      rules.eventTitle.keywords
        .map(nameKey)
        .filter(Boolean)
        .some((keyword) => title.includes(keyword))
    )
      reasons.push("eventTitle");
    const locations = [data.venue, data.address].map(nameKey).filter(Boolean);
    if (
      rules.eventLocation.enabled &&
      data.type === "Event" &&
      rules.eventLocation.keywords
        .map(nameKey)
        .filter(Boolean)
        .some((keyword) =>
          locations.some((location) => location.includes(keyword)),
        )
    )
      reasons.push("eventLocation");
    const tags = data.tags.map(nameKey).filter(Boolean);
    if (
      rules.entityTags.enabled &&
      rules.entityTags.keywords
        .map(nameKey)
        .filter(Boolean)
        .some((keyword) => tags.some((tag) => tag.includes(keyword)))
    )
      reasons.push("entityTags");
    return reasons;
  }
  private updateEntityFiltering(id: string) {
    const row = this.db
      .prepare("SELECT data FROM entities WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) return [] as FilterRuleCode[];
    const sources = this.db
      .prepare(
        "SELECT DISTINCT s.providerId,sc.timezone FROM entity_source_links l JOIN source_items i ON i.id=l.sourceItemId JOIN sources s ON s.id=i.sourceId JOIN scopes sc ON sc.id=s.scopeId WHERE l.entityId=?",
      )
      .all(id) as Array<{ providerId: string; timezone: string }>;
    const reasons = this.filterReasons(
      normalize(JSON.parse(row.data)),
      sources.map((source) => source.providerId),
      sources[0]?.timezone || "Europe/Belgrade",
    );
    this.db
      .prepare("UPDATE entities SET filtered=?,filterReason=? WHERE id=?")
      .run(reasons.length ? 1 : 0, JSON.stringify(reasons), id);
    return reasons;
  }
  reapplyFilterRules() {
    const rows = this.db.prepare("SELECT id FROM entities").all() as Array<{
      id: string;
    }>;
    this.transaction(() => {
      for (const row of rows) this.updateEntityFiltering(row.id);
    });
  }
  sources(): Source[] {
    return (
      this.db
        .prepare("SELECT * FROM sources ORDER BY priority DESC,name")
        .all() as Row[]
    ).map(
      (s) =>
        ({
          ...s,
          enabled: !!s.enabled,
          categories: JSON.parse(s.categories),
          lastResult: s.lastResult ? JSON.parse(s.lastResult) : null,
        }) as Source,
    );
  }
  source(id: string) {
    const s = this.sources().find((s) => s.id === id);
    if (!s) throw new Error("Источник не найден");
    return s;
  }
  saveSource(input: SourceInput, id: string = randomUUID()): Source {
    const s = sourceSchema.parse(input);
    getProvider(s.providerId);
    this.scope(s.scopeId);
    if (
      s.url &&
      [...new URL(s.url).searchParams.keys()].some((k) =>
        /^(apikey|api_key|key|token|access_token|secret|password)$/i.test(k),
      )
    )
      throw new Error(
        "Секреты нельзя сохранять в URL источника. Используйте .env.local и credential adapter.",
      );
    const old = this.db
      .prepare("SELECT providerId FROM sources WHERE id=?")
      .get(id);
    if (old && old.providerId !== s.providerId)
      throw new Error(
        "Провайдера существующего источника менять нельзя. Создайте новый источник.",
      );
    const values = {
      ...s,
      categories: JSON.stringify(s.categories),
      enabled: s.enabled ? 1 : 0,
    };
    if (old) {
      const cols = Object.keys(values);
      this.db
        .prepare(
          `UPDATE sources SET ${cols.map((k) => k + "=?").join(",")},status=?,lastError=NULL,lastTestAt=NULL WHERE id=?`,
        )
        .run(
          ...Object.values(values),
          s.enabled ? "configured" : "disabled",
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO sources (id,${Object.keys(values).join(",")},status) VALUES (${Array(Object.keys(values).length + 2).fill("?")})`,
        )
        .run(
          id,
          ...Object.values(values),
          s.enabled ? "configured" : "disabled",
        );
    }
    return this.source(id);
  }
  seed() {
    this.db
      .prepare("INSERT OR IGNORE INTO scopes VALUES (?,?,?,?,?,?)")
      .run("serbia", "Serbia", "RS", null, "Europe/Belgrade", 3601741311);
    this.db
      .prepare("INSERT OR IGNORE INTO scopes VALUES (?,?,?,?,?,?)")
      .run(
        "belgrade",
        "Belgrade",
        "RS",
        "Belgrade",
        "Europe/Belgrade",
        3602728438,
      );
    for (const p of providers) {
      if (p.hiddenFromSources) continue;
      if (
        this.db
          .prepare("SELECT 1 FROM sources WHERE id=?")
          .get("source-" + p.id)
      )
        continue;
      this.saveSource(
        {
          providerId: p.id,
          name: p.name,
          url: p.defaultUrl || "",
          scopeId: p.id === "serbia-travel" ? "serbia" : "belgrade",
          enabled: ["manual", "allevents", "telegram"].includes(p.id),
          priority: p.id === "overpass" ? 100 : p.id === "manual" ? 90 : 50,
          language: p.id === "afisha" ? "ru" : "",
        },
        "source-" + p.id,
      );
    }
  }
  private presentationTimeZone(
    entity: NormalizedEntity,
    scopes = this.scopes(),
  ) {
    return (
      (
        scopes.find(
          (scope) =>
            scope.country === entity.country && scope.city === entity.city,
        ) || scopes.find((scope) => scope.country === entity.country)
      )?.timezone || zone
    );
  }
  refreshEntityPresentations() {
    const rows = this.db.prepare("SELECT * FROM entities").all() as Row[];
    const scopes = this.scopes();
    this.transaction(() => {
      for (const row of rows) this.rowEntity(row, scopes);
    });
  }
  rowEntity(row: Row, scopes = this.scopes()): Entity {
    const data = entitySchema.parse(JSON.parse(row.data));
    const timeZone = this.presentationTimeZone(data, scopes);
    let presentation = JSON.parse(row.presentation || "{}");
    if (
      presentation.version !== presentationVersion ||
      presentation.timeZone !== timeZone
    ) {
      presentation = buildEntityPresentation(data, timeZone);
      this.db
        .prepare("UPDATE entities SET presentation=? WHERE id=?")
        .run(JSON.stringify(presentation), row.id);
    }
    return {
      ...data,
      presentation,
      id: row.id,
      archived: !!row.archived,
      favorite: !!row.favorite,
      reaction: row.reaction || "",
      dislikeReason: row.dislikeReason || "",
      skipped: !!row.skipped,
      skipReason: row.skipReason || "",
      notes: row.notes,
      filtered: !!row.filtered,
      filterReasons: JSON.parse(row.filterReason || "[]"),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sources: [],
      duplicateCount: 0,
    };
  }
  entities(options: { includeFiltered?: boolean } = {}): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entities ${options.includeFiltered ? "" : "WHERE filtered=0"} ORDER BY updatedAt DESC,id`,
      )
      .all() as Row[];
    const links = this.db
      .prepare(
        "SELECT DISTINCT l.entityId,s.id,s.name,s.providerId FROM entity_source_links l JOIN source_items i ON i.id=l.sourceItemId JOIN sources s ON s.id=i.sourceId",
      )
      .all() as Row[];
    const counts = this.db
      .prepare(
        "SELECT firstId,secondId FROM duplicate_pairs WHERE status='new'",
      )
      .all() as Row[];
    const scopes = this.scopes();
    const byId = new Map(rows.map((r) => [r.id, this.rowEntity(r, scopes)]));
    for (const l of links)
      byId
        .get(l.entityId)
        ?.sources.push({ id: l.id, name: l.name, providerId: l.providerId });
    for (const p of counts) {
      if (byId.has(p.firstId) && byId.has(p.secondId)) {
        byId.get(p.firstId)!.duplicateCount++;
        byId.get(p.secondId)!.duplicateCount++;
      }
    }
    return [...byId.values()];
  }
  entitySummary(id: string): Entity {
    const row = this.db.prepare("SELECT * FROM entities WHERE id=?").get(id);
    if (!row) throw new Error("Активность не найдена");
    const entity = this.rowEntity(row);
    entity.sources = this.db
      .prepare(
        "SELECT DISTINCT s.id,s.name,s.providerId FROM entity_source_links l JOIN source_items i ON i.id=l.sourceItemId JOIN sources s ON s.id=i.sourceId WHERE l.entityId=?",
      )
      .all(id) as Entity["sources"];
    entity.duplicateCount = Number(
      this.db
        .prepare(
          "SELECT count(*) AS count FROM duplicate_pairs WHERE (firstId=? OR secondId=?) AND status='new'",
        )
        .get(id, id)!.count,
    );
    return entity;
  }
  entity(id: string): EntityDetail {
    const e = this.entitySummary(id);
    const provenance = (
      this.db
        .prepare(
          "SELECT i.*,s.name AS sourceName FROM source_items i JOIN sources s ON s.id=i.sourceId JOIN entity_source_links l ON l.sourceItemId=i.id WHERE l.entityId=? ORDER BY i.fetchedAt DESC",
        )
        .all(id) as Row[]
    ).map((i) => ({ ...i, rawPayload: JSON.parse(i.rawPayload) }));
    const related = this.db
      .prepare(
        "SELECT e.id,e.title,e.type,r.relation FROM entity_relations r JOIN entities e ON e.id=CASE WHEN r.fromId=? THEN r.toId ELSE r.fromId END WHERE r.fromId=? OR r.toId=?",
      )
      .all(id, id, id);
    const duplicates = this.db
      .prepare(
        "SELECT e.id,e.title,e.type,p.reason FROM duplicate_pairs p JOIN entities e ON e.id=CASE WHEN p.firstId=? THEN p.secondId ELSE p.firstId END WHERE (p.firstId=? OR p.secondId=?) AND p.status='new'",
      )
      .all(id, id, id);
    return { ...e, provenance, related, duplicates } as EntityDetail;
  }
  collapseEventDuplicates() {
    const events = (
      this.db
        .prepare("SELECT id,data FROM entities WHERE type='Event' ORDER BY id")
        .all() as Array<{ id: string; data: string }>
    ).map((row) => ({
      ...row,
      event: entitySchema.parse(JSON.parse(row.data)),
    }));
    const byId = new Map(events.map((item) => [item.id, item]));
    const parents = new Map(events.map((item) => [item.id, item.id]));
    const find = (id: string): string => {
      const parent = parents.get(id)!;
      if (parent === id) return id;
      const root = find(parent);
      parents.set(id, root);
      return root;
    };
    const join = (a: string, b: string) => {
      const first = find(a),
        second = find(b);
      if (first !== second) parents.set(second, first);
    };
    const ignored = new Set(
      (
        this.db
          .prepare(
            "SELECT firstId,secondId FROM duplicate_pairs WHERE status='ignored'",
          )
          .all() as Array<{ firstId: string; secondId: string }>
      ).map(({ firstId, secondId }) => `${firstId}\u0000${secondId}`),
    );
    const groups = new Map<string, typeof events>();
    for (const item of events) {
      const key = [
        item.event.country,
        item.event.demo ? "demo" : "real",
        nameKey(item.event.title),
        nameKey(item.event.city),
      ].join("\u0000");
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values())
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const [firstId, secondId] = [group[i].id, group[j].id].sort();
          if (
            !ignored.has(`${firstId}\u0000${secondId}`) &&
            canCollapseEvents(group[i].event, group[j].event)
          )
            join(group[i].id, group[j].id);
        }
    const forcedPairs = this.db
      .prepare(
        "SELECT firstId,secondId FROM duplicate_pairs WHERE status='new'",
      )
      .all() as Array<{ firstId: string; secondId: string }>;
    for (const { firstId, secondId } of forcedPairs) {
      const first = byId.get(firstId),
        second = byId.get(secondId);
      if (
        first &&
        second &&
        first.event.country === second.event.country &&
        first.event.demo === second.event.demo
      )
        join(firstId, secondId);
    }
    const components = new Map<string, typeof events>();
    for (const item of events) {
      const root = find(item.id);
      const component = components.get(root) || [];
      component.push(item);
      components.set(root, component);
    }
    const duplicateGroups = [...components.values()]
      .filter((component) => component.length > 1)
      .map((component) =>
        component.sort(
          (a, b) =>
            (a.event.startAt || "\uffff").localeCompare(
              b.event.startAt || "\uffff",
            ) || a.id.localeCompare(b.id),
        ),
      );
    if (!duplicateGroups.length) return 0;
    return this.transaction(() => {
      let collapsed = 0;
      for (const component of duplicateGroups) {
        const keepId = component[0].id;
        for (const duplicate of component.slice(1)) {
          this.mergeEntities(keepId, duplicate.id);
          collapsed++;
        }
      }
      return collapsed;
    });
  }
  archivePastEvents(scopeId: string, today?: string) {
    const scope = this.scope(scopeId);
    const cutoffDate = today || localDay(new Date(), scope.timezone);
    return this.transaction(() => {
      const candidates = (
        this.db
          .prepare(
            "SELECT id,data FROM entities WHERE type='Event' AND country=? AND (? IS NULL OR city=?) AND startAt!=''",
          )
          .all(scope.country, scope.city, scope.city) as {
          id: string;
          data: string;
        }[]
      ).filter(({ data }) => {
        const event = entitySchema.parse(JSON.parse(data));
        return isPastEvent(
          event.startAt,
          event.endAt,
          cutoffDate,
          scope.timezone,
        );
      });
      for (const candidate of candidates) {
        const event = this.entity(candidate.id);
        this.db
          .prepare(
            "INSERT INTO past_events_archive (entityId,title,country,city,startAt,endAt,snapshot,archivedAt) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            event.id,
            event.title,
            event.country,
            event.city,
            event.startAt,
            event.endAt,
            JSON.stringify(event),
            now(),
          );
        this.db.prepare("DELETE FROM entities WHERE id=?").run(event.id);
      }
      return { archived: candidates.length, cutoffDate };
    });
  }
  writeEntity(id: string, data: NormalizedEntity) {
    this.db
      .prepare(
        "UPDATE entities SET type=?,title=?,country=?,city=?,startAt=?,data=?,presentation=?,updatedAt=? WHERE id=?",
      )
      .run(
        data.type,
        data.title,
        data.country,
        data.city,
        data.startAt,
        JSON.stringify(data),
        JSON.stringify(
          buildEntityPresentation(data, this.presentationTimeZone(data)),
        ),
        now(),
        id,
      );
    this.db
      .prepare(
        "DELETE FROM entity_keys WHERE entityId=? AND key NOT LIKE 'provider:%'",
      )
      .run(id);
    this.insertKeys(id, data);
  }
  insertKeys(id: string, data: NormalizedEntity) {
    for (const key of identityKeys(data))
      this.db
        .prepare("INSERT OR IGNORE INTO entity_keys VALUES (?,?)")
        .run(key, id);
  }
  ingest(
    source: Source,
    items: { raw: RawItem; entity: EntityInput }[],
    dryRun = false,
  ): SyncResult {
    return this.transaction(() => {
      if (dryRun) this.db.exec("SAVEPOINT preview");
      const totals = result();
      totals.fetched = items.length;
      let prepared = items;
      if (source.providerId === "tickets") {
        const selected = new Map<
          string,
          { index: number; record: (typeof items)[number]; startAt: string }
        >();
        const standalone: { index: number; record: (typeof items)[number] }[] =
          [];
        items.forEach((record, index) => {
          const normalized = normalize(record.entity);
          const key = ticketsSeriesKey(normalized);
          if (!key) {
            standalone.push({ index, record });
            return;
          }
          const current = selected.get(key);
          const order = `${normalized.startAt}\u0000${record.raw.externalId}`;
          if (!current) {
            selected.set(key, { index, record, startAt: order });
            return;
          }
          totals.duplicates++;
          if (order < current.startAt)
            selected.set(key, { index, record, startAt: order });
        });
        prepared = [
          ...standalone,
          ...[...selected.values()].map(({ index, record }) => ({
            index,
            record,
          })),
        ]
          .sort((a, b) => a.index - b.index)
          .map(({ record }) => record);
        if (totals.duplicates)
          totals.warnings.push(
            `Tickets.rs: объединены повторные показы с одинаковым содержимым: ${totals.duplicates}; оставлена ближайшая дата/время.`,
          );
      }
      try {
        for (const { raw, entity } of prepared) {
          const data = normalize(entity);
          const seriesKey =
            source.providerId === "tickets" ? ticketsSeriesKey(data) : "";
          const providerIdentity = seriesKey
            ? `provider:tickets:series:${seriesKey}`
            : "";
          const checksum = digest(raw.payload);
          const existingItem = this.db
            .prepare(
              "SELECT id FROM source_items WHERE sourceId=? AND externalId=? AND checksum=?",
            )
            .get(source.id, raw.externalId, checksum);
          const itemId = (existingItem?.id as string) || randomUUID();
          let aggressiveEventMatch = false;
          const matches = this.db
            .prepare(
              "SELECT DISTINCT e.* FROM entities e JOIN entity_source_links l ON l.entityId=e.id JOIN source_items i ON i.id=l.sourceItemId JOIN sources s ON s.id=i.sourceId WHERE s.providerId=? AND (s.id=? OR s.providerId IN ('overpass','ticketmaster')) AND i.externalId=? AND e.type=? AND e.country=? AND json_extract(e.data,'$.demo')=?",
            )
            .all(
              source.providerId,
              source.id,
              raw.externalId,
              data.type,
              data.country,
              data.demo ? 1 : 0,
            ) as Row[];
          if (!matches.length && providerIdentity)
            matches.push(
              ...(this.db
                .prepare(
                  "SELECT e.* FROM entity_keys k JOIN entities e ON e.id=k.entityId WHERE k.key=?",
                )
                .all(providerIdentity) as Row[]),
            );
          // Existing databases predate the persistent Tickets.rs series key.
          // Match their canonical payload once, then store the key below.
          if (!matches.length && seriesKey) {
            const rows = this.db
              .prepare(
                "SELECT DISTINCT e.* FROM entities e JOIN entity_source_links l ON l.entityId=e.id JOIN source_items i ON i.id=l.sourceItemId JOIN sources s ON s.id=i.sourceId WHERE s.providerId='tickets' AND e.type='Event' AND e.country=? AND json_extract(e.data,'$.demo')=?",
              )
              .all(data.country, data.demo ? 1 : 0) as Row[];
            for (const row of rows)
              if (ticketsSeriesKey(JSON.parse(row.data)) === seriesKey)
                matches.push(row);
          }
          if (!matches.length)
            for (const key of identityKeys(data)) {
              const rows = this.db
                .prepare(
                  "SELECT e.* FROM entity_keys k JOIN entities e ON e.id=k.entityId WHERE k.key=?",
                )
                .all(key) as Row[];
              for (const row of rows)
                if (!matches.some((m) => m.id === row.id)) matches.push(row);
            }
          // Also cover Event rows indexed before the current identity-key
          // version: exact title + instant + city is a final-write duplicate.
          if (!matches.length && data.type === "Event" && data.startAt) {
            const rows = this.db
              .prepare(
                "SELECT * FROM entities WHERE type='Event' AND country=? AND startAt=? AND json_extract(data,'$.demo')=?",
              )
              .all(data.country, data.startAt, data.demo ? 1 : 0) as Row[];
            for (const row of rows) {
              const previous: NormalizedEntity = JSON.parse(row.data);
              if (
                nameKey(previous.title) === nameKey(data.title) &&
                nameKey(previous.city) === nameKey(data.city)
              )
                matches.push(row);
            }
          }
          if (!matches.length && data.type === "Event") {
            const rows = this.db
              .prepare(
                "SELECT * FROM entities WHERE type='Event' AND country=? AND json_extract(data,'$.demo')=?",
              )
              .all(data.country, data.demo ? 1 : 0) as Row[];
            for (const row of rows) {
              const previous = entitySchema.parse(JSON.parse(row.data));
              if (canCollapseEvents(previous, data)) matches.push(row);
            }
            aggressiveEventMatch = matches.length > 0;
          }
          if (data.type === "Event" && matches.length > 1) {
            aggressiveEventMatch = true;
            const ordered = [
              ...new Map(matches.map((row) => [row.id, row])).values(),
            ]
              .map((row) => ({
                row,
                event: entitySchema.parse(JSON.parse(row.data)),
              }))
              .sort(
                (a, b) =>
                  (a.event.startAt || "\uffff").localeCompare(
                    b.event.startAt || "\uffff",
                  ) || a.row.id.localeCompare(b.row.id),
              );
            const keepId = ordered[0].row.id;
            for (const duplicate of ordered.slice(1))
              this.mergeEntities(keepId, duplicate.row.id);
            matches.splice(
              0,
              matches.length,
              this.db
                .prepare("SELECT * FROM entities WHERE id=?")
                .get(keepId) as Row,
            );
          }
          let id: string;
          let action: "created" | "updated" | "duplicates";
          if (matches.length >= 1) {
            const row = matches[0];
            id = row.id;
            const previous: NormalizedEntity = JSON.parse(row.data);
            const incoming = Object.fromEntries(
              Object.entries(data).filter(
                ([k, v]) =>
                  v !== "" &&
                  v !== null &&
                  (!Array.isArray(v) || v.length) &&
                  ![
                    "demo",
                    "aiDecision",
                    "aiScore",
                    "aiReason",
                    "aiTags",
                    "aiProcessedAt",
                  ].includes(k),
              ),
            );
            const earliest = aggressiveEventMatch
              ? earlierEvent(previous, data)
              : null;
            const overrides = JSON.parse(row.overrides) as Record<
              string,
              unknown
            >;
            const combinedInput = earliest
              ? {
                  ...(earliest === previous ? data : previous),
                  ...Object.fromEntries(
                    Object.entries(earliest).filter(
                      ([, value]) =>
                        value !== "" &&
                        value !== null &&
                        (!Array.isArray(value) || value.length),
                    ),
                  ),
                  tags: [...new Set([...previous.tags, ...data.tags])],
                  knownIds: {
                    ...(earliest === previous
                      ? data.knownIds
                      : previous.knownIds),
                    ...earliest.knownIds,
                  },
                  ...overrides,
                }
              : {
                  ...previous,
                  ...incoming,
                  tags: [...new Set([...previous.tags, ...data.tags])],
                  knownIds: { ...previous.knownIds, ...data.knownIds },
                  ...overrides,
                };
            if (
              !earliest &&
              data.type === "Event" &&
              data.startAt &&
              data.startAt !== previous.startAt &&
              !("endAt" in overrides)
            )
              combinedInput.endAt = data.endAt;
            const combined = normalize(combinedInput);
            const head = this.db
              .prepare(
                "SELECT sourceItemId,normalizedChecksum FROM source_item_heads WHERE sourceId=? AND externalId=?",
              )
              .get(source.id, raw.externalId);
            action =
              (existingItem &&
                head?.sourceItemId === itemId &&
                head?.normalizedChecksum === digest(data)) ||
              digest(previous) === digest(combined)
                ? "duplicates"
                : "updated";
            if (action === "updated") this.writeEntity(id, combined);
          } else {
            id = randomUUID();
            this.db
              .prepare(
                "INSERT INTO entities (id,type,title,country,city,startAt,data,presentation,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                data.type,
                data.title,
                data.country,
                data.city,
                data.startAt,
                JSON.stringify(data),
                JSON.stringify(
                  buildEntityPresentation(
                    data,
                    this.presentationTimeZone(data),
                  ),
                ),
                now(),
                now(),
              );
            this.insertKeys(id, data);
            action = "created";
          }
          totals[action]++;
          if (!existingItem)
            this.db
              .prepare("INSERT INTO source_items VALUES (?,?,?,?,?,?,?,?,?)")
              .run(
                itemId,
                source.id,
                raw.externalId,
                raw.url || "",
                raw.rawText,
                JSON.stringify(raw.payload),
                raw.publishedAt || null,
                now(),
                checksum,
              );
          else
            this.db
              .prepare("UPDATE source_items SET fetchedAt=? WHERE id=?")
              .run(now(), itemId);
          if (source.providerId === "allevents") {
            const archivedPayload =
              raw.payload &&
              typeof raw.payload === "object" &&
              "original" in raw.payload
                ? (raw.payload as { original: unknown }).original
                : raw.payload;
            const stamp = now();
            this.db
              .prepare(
                "INSERT INTO allevents_raw_events (sourceId,eventId,sourceItemId,eventUrl,startAt,endAt,categorySlugs,rawPayload,rawChecksum,firstSeenAt,lastSeenAt) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sourceId,eventId) DO UPDATE SET sourceItemId=excluded.sourceItemId,eventUrl=excluded.eventUrl,startAt=excluded.startAt,endAt=excluded.endAt,categorySlugs=excluded.categorySlugs,rawPayload=excluded.rawPayload,rawChecksum=excluded.rawChecksum,lastSeenAt=excluded.lastSeenAt",
              )
              .run(
                source.id,
                raw.externalId,
                itemId,
                raw.url || "",
                data.startAt,
                data.endAt,
                JSON.stringify(data.tags),
                JSON.stringify(archivedPayload),
                digest(archivedPayload),
                stamp,
                stamp,
              );
          }
          this.db
            .prepare("INSERT OR IGNORE INTO entity_source_links VALUES (?,?)")
            .run(id, itemId);
          if (providerIdentity)
            this.db
              .prepare("INSERT OR IGNORE INTO entity_keys VALUES (?,?)")
              .run(providerIdentity, id);
          this.db
            .prepare(
              "INSERT INTO source_item_heads VALUES (?,?,?,?) ON CONFLICT(sourceId,externalId) DO UPDATE SET sourceItemId=excluded.sourceItemId,normalizedChecksum=excluded.normalizedChecksum",
            )
            .run(source.id, raw.externalId, itemId, digest(data));
          const reasons = this.updateEntityFiltering(id);
          if (reasons.length) totals.filtered++;
          const possible = (
            this.db
              .prepare(
                "SELECT * FROM entities WHERE type=? AND country=? AND id!=? AND json_extract(data,'$.demo')=?",
              )
              .all(data.type, data.country, id, data.demo ? 1 : 0) as Row[]
          ).filter((r) => {
            const e = JSON.parse(r.data);
            return (
              nameKey(e.title) === nameKey(data.title) &&
              nameKey(e.city) === nameKey(data.city) &&
              (data.type !== "Event" ||
                !e.startAt ||
                !data.startAt ||
                e.startAt.slice(0, 10) === data.startAt.slice(0, 10))
            );
          });
          for (const r of [
            ...possible,
            ...(matches.length > 1
              ? matches.filter((match) => match.id !== id)
              : []),
          ]) {
            const [a, b] = [id, r.id].sort();
            this.db
              .prepare(
                "INSERT OR IGNORE INTO duplicate_pairs VALUES (?,?,?,'new')",
              )
              .run(
                a,
                b,
                "Похожее название и география; точных данных недостаточно для автоматического объединения.",
              );
          }
          if (!reasons.length) this.discover(source, itemId, id, raw, data);
        }
      } finally {
        if (dryRun) this.db.exec("ROLLBACK TO preview; RELEASE preview");
      }
      if (totals.filtered)
        totals.warnings.push(
          `Скрыто статичными правилами фильтрации: ${totals.filtered}.`,
        );
      return totals;
    });
  }
  estimateAllEvents(
    sourceId: string,
    startDate: string,
    endDate: string,
    categories: string[],
  ) {
    const all = !categories.length || categories.includes("all");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM allevents_raw_events a
         WHERE a.sourceId=?
           AND (?='' OR substr(a.startAt,1,10)>=?)
           AND (?='' OR substr(a.startAt,1,10)<=?)
           AND (?=1 OR EXISTS (
             SELECT 1 FROM json_each(a.categorySlugs)
             WHERE lower(json_each.value) IN (${categories.map(() => "?").join(",") || "''"})
           ))`,
      )
      .get(
        sourceId,
        startDate,
        startDate,
        endDate,
        endDate,
        all ? 1 : 0,
        ...categories.map((c) => c.toLowerCase()),
      ) as { count: number };
    return row.count;
  }
  discover(
    source: Source,
    itemId: string,
    entityId: string,
    raw: RawItem,
    data: NormalizedEntity,
  ) {
    if (data.demo) return;
    const urls = new Set(
      (JSON.stringify(raw.payload) + " " + raw.rawText).match(
        /https?:\/\/[^\s<>"\\]+/g,
      ) || [],
    );
    if (data.website) urls.add(data.website);
    for (const v of [...urls].slice(0, 40)) {
      const url = canonicalUrl(v.replace(/[.,);]+$/, ""));
      if (!url || url === canonicalUrl(raw.url)) continue;
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (
        /\.(png|jpe?g|webp|gif|svg|woff2?)$/i.test(u.pathname) ||
        ["schema.org", "www.schema.org", "openstreetmap.org"].includes(
          u.hostname,
        )
      )
        continue;
      if (this.sources().some((s) => canonicalUrl(s.url) === url)) continue;
      const type = /(^|\.)t\.me$/.test(u.hostname)
        ? "telegram"
        : /(^|\.)instagram\.com$/.test(u.hostname)
          ? "instagram"
          : /(^|\.)facebook\.com$/.test(u.hostname)
            ? "facebook-apify"
            : "structured";
      this.db
        .prepare(
          "INSERT OR IGNORE INTO source_candidates VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          u.hostname + u.pathname.replace(/\/$/, ""),
          url,
          itemId,
          type,
          source.scopeId,
          "Ссылка в записи «" + data.title + "»",
          "new",
          entityId,
        );
    }
  }
  editEntity(id: string, input: EntityInput) {
    const current = this.entity(id);
    const data = normalize({ ...input, demo: current.demo });
    if (data.type !== current.type)
      throw new Error("Тип существующей записи менять нельзя.");
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT overrides FROM entities WHERE id=?")
        .get(id)!;
      const overrides = JSON.parse(String(row.overrides));
      for (const [k, v] of Object.entries(data))
        if (digest(v) !== digest((current as unknown as Row)[k]))
          overrides[k] = v;
      this.db
        .prepare("UPDATE entities SET overrides=? WHERE id=?")
        .run(JSON.stringify(overrides), id);
      this.writeEntity(id, data);
      this.updateEntityFiltering(id);
    });
    return this.entity(id);
  }
  setState(
    id: string,
    state: {
      archived?: boolean;
      favorite?: boolean;
      reaction?: EntityReaction;
      dislikeReason?: string;
      skipped?: boolean;
      skipReason?: string;
      notes?: string;
    },
  ) {
    state = normalizePersonalStatePatch(state);
    const row = this.db.prepare("SELECT type FROM entities WHERE id=?").get(id);
    if (!row) throw new Error("Активность не найдена");
    if (
      (state.reaction !== undefined ||
        state.dislikeReason !== undefined ||
        state.skipped !== undefined ||
        state.skipReason !== undefined) &&
      row.type !== "Event"
    )
      throw new Error("Оценивать можно только мероприятия");
    const fields = (
      [
        "archived",
        "favorite",
        "reaction",
        "notes",
        "dislikeReason",
        "skipped",
        "skipReason",
      ] as const
    ).filter((key) => state[key] !== undefined);
    if (fields.length)
      this.db
        .prepare(
          `UPDATE entities SET ${fields.map((key) => `${key}=?`).join(",")},updatedAt=? WHERE id=?`,
        )
        .run(
          ...fields.map((key) =>
            typeof state[key] === "boolean" ? Number(state[key]) : state[key]!,
          ),
          now(),
          id,
        );
    return this.entitySummary(id);
  }
  candidates(): Candidate[] {
    return this.db
      .prepare(
        "SELECT * FROM source_candidates ORDER BY CASE probableType WHEN 'telegram' THEN 0 WHEN 'instagram' THEN 1 ELSE 2 END,name",
      )
      .all() as unknown as Candidate[];
  }
  candidateAction(id: string, action: "accept" | "ignore") {
    return this.transaction(() => {
      const c = this.candidates().find((c) => c.id === id);
      if (!c) throw new Error("Кандидат не найден");
      if (c.status !== "new") throw new Error("Кандидат уже обработан");
      let source: Source | undefined;
      if (action === "accept")
        source =
          this.sources().find((s) => canonicalUrl(s.url) === c.url) ||
          this.saveSource({
            providerId: c.probableType,
            name: c.name,
            url: c.url,
            scopeId: c.scopeId,
            enabled: false,
          });
      this.db
        .prepare("UPDATE source_candidates SET status=? WHERE id=?")
        .run(action === "accept" ? "accepted" : "ignored", id);
      return source;
    });
  }
  private mergeEntities(keepId: string, removeId: string) {
    if (keepId === removeId)
      throw new Error("Нельзя объединить запись с собой");
    const keepRow = this.db
        .prepare("SELECT * FROM entities WHERE id=?")
        .get(keepId) as Row,
      removeRow = this.db
        .prepare("SELECT * FROM entities WHERE id=?")
        .get(removeId) as Row;
    if (!keepRow || !removeRow) throw new Error("Активность не найдена");
    const a = entitySchema.parse(JSON.parse(keepRow.data)),
      b = entitySchema.parse(JSON.parse(removeRow.data));
    if (a.type !== b.type || a.country !== b.country || a.demo !== b.demo)
      throw new Error(
        "Можно объединить записи одного типа, страны и demo-статуса.",
      );
    const merged: NormalizedEntity = normalize({
      ...b,
      ...Object.fromEntries(
        Object.entries(a).filter(([, v]) => v !== "" && v !== null),
      ),
      tags: [...new Set([...b.tags, ...a.tags])],
      knownIds: { ...b.knownIds, ...a.knownIds },
    });
    if (merged.type === "Event") {
      const earliest = earlierEvent(a, b);
      merged.startAt = earliest.startAt;
      merged.endAt = earliest.endAt;
    }
    this.writeEntity(keepId, merged);
    this.db
      .prepare(
        "UPDATE entities SET favorite=?,reaction=?,notes=?,dislikeReason=?,skipped=?,skipReason=?,overrides=? WHERE id=?",
      )
      .run(
        keepRow.favorite || removeRow.favorite ? 1 : 0,
        keepRow.reaction || removeRow.reaction || "",
        [keepRow.notes, removeRow.notes].filter(Boolean).join("\n"),
        // Keep the reason belonging to the surviving reaction, not a conflicting duplicate.
        (keepRow.reaction ? keepRow.dislikeReason : removeRow.dislikeReason) ||
          "",
        keepRow.reaction || removeRow.reaction
          ? 0
          : Number(!!(keepRow.skipped || removeRow.skipped)),
        (keepRow.skipped ? keepRow.skipReason : removeRow.skipReason) || "",
        JSON.stringify({
          ...JSON.parse(removeRow.overrides),
          ...JSON.parse(keepRow.overrides),
        }),
        keepId,
      );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO entity_source_links SELECT ?,sourceItemId FROM entity_source_links WHERE entityId=?",
      )
      .run(keepId, removeId);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO entity_keys SELECT key,? FROM entity_keys WHERE entityId=? AND key LIKE 'provider:%'",
      )
      .run(keepId, removeId);
    const rels = this.db
      .prepare("SELECT * FROM entity_relations WHERE fromId=? OR toId=?")
      .all(removeId, removeId) as Row[];
    for (const r of rels) {
      const from = r.fromId === removeId ? keepId : r.fromId,
        to = r.toId === removeId ? keepId : r.toId;
      if (from !== to)
        this.db
          .prepare("INSERT OR IGNORE INTO entity_relations VALUES (?,?,?)")
          .run(from, to, r.relation);
    }
    const duplicatePairs = this.db
      .prepare("SELECT * FROM duplicate_pairs WHERE firstId=? OR secondId=?")
      .all(removeId, removeId) as Row[];
    for (const pair of duplicatePairs) {
      const other = pair.firstId === removeId ? pair.secondId : pair.firstId;
      if (other === keepId) continue;
      const [firstId, secondId] = [keepId, other].sort();
      this.db
        .prepare("INSERT OR IGNORE INTO duplicate_pairs VALUES (?,?,?,?)")
        .run(firstId, secondId, pair.reason, pair.status);
    }
    this.db
      .prepare("UPDATE source_candidates SET entityId=? WHERE entityId=?")
      .run(keepId, removeId);
    this.db.prepare("DELETE FROM entities WHERE id=?").run(removeId);
    this.updateEntityFiltering(keepId);
  }
  merge(keepId: string, removeId: string) {
    return this.transaction(() => {
      this.mergeEntities(keepId, removeId);
      return this.entity(keepId);
    });
  }
  ignoreDuplicate(a: string, b: string) {
    const [x, y] = [a, b].sort();
    this.db
      .prepare(
        "UPDATE duplicate_pairs SET status='ignored' WHERE firstId=? AND secondId=?",
      )
      .run(x, y);
  }
  relate(from: string, to: string, relation: string, remove = false) {
    this.entity(from);
    this.entity(to);
    if (from === to) throw new Error("Выберите другую запись");
    if (remove)
      this.db
        .prepare(
          "DELETE FROM entity_relations WHERE fromId=? AND toId=? AND relation=?",
        )
        .run(from, to, relation);
    else
      this.db
        .prepare("INSERT OR IGNORE INTO entity_relations VALUES (?,?,?)")
        .run(from, to, relation);
  }
  deleteDemo() {
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM entities WHERE json_extract(data,'$.demo')=1; DELETE FROM source_items WHERE id NOT IN (SELECT sourceItemId FROM entity_source_links) AND sourceId='source-manual';",
      );
    });
  }
  close() {
    this.db.close();
  }
}

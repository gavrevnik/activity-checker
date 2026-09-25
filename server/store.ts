import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entitySchema,
  sourceSchema,
  type Entity,
  type EntityDetail,
  type EntityInput,
  type NormalizedEntity,
  type Scope,
  type Source,
  type SourceInput,
  type SyncResult,
  type Candidate,
} from "../shared/model.js";
import {
  canonicalUrl,
  digest,
  identityKeys,
  nameKey,
  normalize,
} from "./normalize.js";
import type { RawItem } from "./providers/types.js";
import { providers, getProvider } from "./providers/registry.js";
const now = () => new Date().toISOString();
const result = (): SyncResult => ({
  fetched: 0,
  created: 0,
  updated: 0,
  duplicates: 0,
  errors: 0,
  warnings: [],
});
type Row = Record<string, any>;
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
          enabled: ["overpass", "manual"].includes(p.id),
          priority: p.id === "overpass" ? 100 : p.id === "manual" ? 90 : 50,
          language: p.id === "afisha" ? "ru" : "",
        },
        "source-" + p.id,
      );
    }
  }
  rowEntity(row: Row): Entity {
    return {
      ...JSON.parse(row.data),
      id: row.id,
      archived: !!row.archived,
      favorite: !!row.favorite,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sources: [],
      duplicateCount: 0,
    };
  }
  entities(): Entity[] {
    const rows = this.db
      .prepare("SELECT * FROM entities ORDER BY updatedAt DESC,id")
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
    const byId = new Map(rows.map((r) => [r.id, this.rowEntity(r)]));
    for (const l of links)
      byId
        .get(l.entityId)
        ?.sources.push({ id: l.id, name: l.name, providerId: l.providerId });
    for (const p of counts) {
      if (byId.has(p.firstId)) byId.get(p.firstId)!.duplicateCount++;
      if (byId.has(p.secondId)) byId.get(p.secondId)!.duplicateCount++;
    }
    return [...byId.values()];
  }
  entity(id: string): EntityDetail {
    const e = this.entities().find((e) => e.id === id);
    if (!e) throw new Error("Активность не найдена");
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
  writeEntity(id: string, data: NormalizedEntity) {
    this.db
      .prepare(
        "UPDATE entities SET type=?,title=?,country=?,city=?,startAt=?,data=?,updatedAt=? WHERE id=?",
      )
      .run(
        data.type,
        data.title,
        data.country,
        data.city,
        data.startAt,
        JSON.stringify(data),
        now(),
        id,
      );
    this.db.prepare("DELETE FROM entity_keys WHERE entityId=?").run(id);
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
      try {
        for (const { raw, entity } of items) {
          const data = normalize(entity);
          const checksum = digest(raw.payload);
          const existingItem = this.db
            .prepare(
              "SELECT id FROM source_items WHERE sourceId=? AND externalId=? AND checksum=?",
            )
            .get(source.id, raw.externalId, checksum);
          const itemId = (existingItem?.id as string) || randomUUID();
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
          let id: string;
          let action: "created" | "updated" | "duplicates";
          if (matches.length === 1) {
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
            const combined = normalize({
              ...previous,
              ...incoming,
              tags: [...new Set([...previous.tags, ...data.tags])],
              knownIds: { ...previous.knownIds, ...data.knownIds },
              ...JSON.parse(row.overrides),
            });
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
                "INSERT INTO entities (id,type,title,country,city,startAt,data,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                data.type,
                data.title,
                data.country,
                data.city,
                data.startAt,
                JSON.stringify(data),
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
          this.db
            .prepare("INSERT OR IGNORE INTO entity_source_links VALUES (?,?)")
            .run(id, itemId);
          this.db
            .prepare(
              "INSERT INTO source_item_heads VALUES (?,?,?,?) ON CONFLICT(sourceId,externalId) DO UPDATE SET sourceItemId=excluded.sourceItemId,normalizedChecksum=excluded.normalizedChecksum",
            )
            .run(source.id, raw.externalId, itemId, digest(data));
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
            ...(matches.length > 1 ? matches : []),
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
          this.discover(source, itemId, id, raw, data);
        }
      } finally {
        if (dryRun) this.db.exec("ROLLBACK TO preview; RELEASE preview");
      }
      return totals;
    });
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
            ? "facebook-scrapecreators"
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
    });
    return this.entity(id);
  }
  setState(
    id: string,
    state: { archived?: boolean; favorite?: boolean; notes?: string },
  ) {
    this.entity(id);
    for (const [k, v] of Object.entries(state))
      this.db
        .prepare(`UPDATE entities SET ${k}=?,updatedAt=? WHERE id=?`)
        .run(typeof v === "boolean" ? Number(v) : v, now(), id);
    return this.entity(id);
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
  merge(keepId: string, removeId: string) {
    return this.transaction(() => {
      if (keepId === removeId)
        throw new Error("Нельзя объединить запись с собой");
      const keep = this.entity(keepId),
        remove = this.entity(removeId);
      if (
        keep.type !== remove.type ||
        keep.country !== remove.country ||
        keep.demo !== remove.demo
      )
        throw new Error(
          "Можно объединить записи одного типа, страны и demo-статуса.",
        );
      const keepRow = this.db
          .prepare("SELECT * FROM entities WHERE id=?")
          .get(keepId) as Row,
        removeRow = this.db
          .prepare("SELECT * FROM entities WHERE id=?")
          .get(removeId) as Row;
      const a = JSON.parse(keepRow.data),
        b = JSON.parse(removeRow.data);
      const merged = {
        ...b,
        ...Object.fromEntries(
          Object.entries(a).filter(([, v]) => v !== "" && v !== null),
        ),
        tags: [...new Set([...b.tags, ...a.tags])],
        knownIds: { ...b.knownIds, ...a.knownIds },
      };
      this.writeEntity(keepId, normalize(merged));
      this.db
        .prepare(
          "UPDATE entities SET favorite=?,notes=?,overrides=? WHERE id=?",
        )
        .run(
          keep.favorite || remove.favorite ? 1 : 0,
          [keep.notes, remove.notes].filter(Boolean).join("\n"),
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
      this.db
        .prepare("UPDATE source_candidates SET entityId=? WHERE entityId=?")
        .run(keepId, removeId);
      this.db.prepare("DELETE FROM entities WHERE id=?").run(removeId);
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

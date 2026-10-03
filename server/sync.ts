import type { Store } from "./store.js";
import { randomUUID } from "node:crypto";
import { getProvider, providerInfo } from "./providers/registry.js";
import { readSecrets, safeError } from "./secrets.js";
import { googlePlacesQuotaStatus } from "./providers/google-places/quota.js";
import { autoArchivePastEvents } from "./auto-archive.js";
import {
  syncOptionsSchema,
  type SourceView,
  type SyncPlan,
  type SyncResult,
  type SyncRun,
} from "../shared/model.js";
export class SyncService {
  private busy = false;
  constructor(private store: Store) {}
  views(): SourceView[] {
    return this.store.sources().map((source) => {
      const provider = getProvider(source.providerId);
      const ctx = {
        source,
        scope: this.store.scope(source.scopeId),
        secrets: readSecrets(),
        store: this.store,
      };
      const count = this.store.db
        .prepare(
          "SELECT COUNT(DISTINCT l.entityId) AS count FROM entity_source_links l JOIN source_items i ON i.id=l.sourceItemId WHERE i.sourceId=?",
        )
        .get(source.id) as { count: number };
      const googlePlacesQuota =
        source.providerId === "google-places-api"
          ? googlePlacesQuotaStatus(this.store)
          : null;
      const proQuota = googlePlacesQuota?.bySku.pro;
      const enterpriseQuota = googlePlacesQuota?.bySku.enterprise;
      return {
        ...source,
        provider: providerInfo(provider),
        connection: provider.connectionStatus(ctx),
        itemCount: count.count,
        ...(googlePlacesQuota && proQuota && proQuota.limit !== null
          ? {
              quotaUsage: {
                sku: "pro" as const,
                used: proQuota.used,
                limit: proQuota.limit,
                remaining: proQuota.remaining ?? 0,
                billingMonth: googlePlacesQuota.billingMonth,
              },
            }
          : {}),
        ...(googlePlacesQuota &&
        enterpriseQuota &&
        enterpriseQuota.limit !== null
          ? {
              enterpriseQuotaUsage: {
                sku: "enterprise" as const,
                used: enterpriseQuota.used,
                limit: enterpriseQuota.limit,
                remaining: enterpriseQuota.remaining ?? 0,
                billingMonth: googlePlacesQuota.billingMonth,
              },
            }
          : {}),
      };
    });
  }
  async run(
    id: string,
    test = false,
    input: unknown = {},
  ): Promise<SyncResult | { message: string }> {
    if (this.busy)
      throw new Error("Другая проверка или синхронизация ещё выполняется.");
    const source = this.store.source(id),
      provider = getProvider(source.providerId);
    const ctx = {
      source,
      scope: this.store.scope(source.scopeId),
      secrets: readSecrets(),
      store: this.store,
    };
    const state = provider.connectionStatus(ctx);
    if (test ? !state.canTest : !state.canSync) throw new Error(state.message);
    const options = syncOptionsSchema.parse(input);
    if (!test && provider.requiresSyncConfirmation && !options.confirmed)
      throw new Error(
        "Синхронизацию нужно подтвердить после просмотра параметров и оценки запросов.",
      );
    const last = this.store.db
      .prepare(
        "SELECT MAX(lastAttemptAt) AS stamp FROM sources WHERE providerId=?",
      )
      .get(source.providerId) as { stamp: string | null };
    if (!test && last.stamp && Date.now() - Date.parse(last.stamp) < 60000)
      throw new Error(
        "Повторный запрос к этому провайдеру доступен через " +
          Math.ceil((60000 - Date.now() + Date.parse(last.stamp)) / 1000) +
          " сек.",
      );
    this.busy = true;
    const runId = randomUUID(),
      startedAt = new Date().toISOString();
    if (!test)
      this.store.db
        .prepare("UPDATE sources SET lastAttemptAt=? WHERE id=?")
        .run(startedAt, id);
    if (
      test &&
      source.lastTestAt &&
      Date.now() - Date.parse(source.lastTestAt) < 5000
    ) {
      this.busy = false;
      throw new Error("Повторите проверку через несколько секунд.");
    }
    if (!test)
      this.store.db
        .prepare(
          "INSERT INTO sync_runs (id,sourceId,startedAt,status) VALUES (?,?,?,'running')",
        )
        .run(runId, id, startedAt);
    try {
      if (test) {
        const message = await provider.testConnection(ctx);
        this.store.db
          .prepare(
            "UPDATE sources SET status='connected',lastTestAt=?,lastError=NULL WHERE id=?",
          )
          .run(new Date().toISOString(), id);
        return { message };
      }
      const isAggregator = provider.group === "API Агрегаторы";
      let archived = isAggregator
        ? autoArchivePastEvents(this.store, source.scopeId).archived
        : 0;
      const fetched = await provider.sync(ctx, options);
      const warnings = [...(fetched.warnings || [])];
      const records = [];
      let errors = 0;
      for (const raw of fetched.items) {
        try {
          const entity = provider.normalize(raw, ctx);
          if (entity) records.push({ raw, entity });
          else warnings.push("Пропущена запись без достаточных данных.");
        } catch (e) {
          errors++;
          warnings.push("Запись " + raw.externalId + ": " + safeError(e));
        }
      }
      // Entire validated batch commits atomically, including provenance and candidates.
      const result = this.store.ingest(source, records);
      // A provider can return old records again; keep those out of the active feed too.
      if (isAggregator)
        archived += autoArchivePastEvents(this.store, source.scopeId).archived;
      if (archived)
        warnings.push(`Автоархив: ${archived} прошедших мероприятий.`);
      result.fetched = fetched.items.length;
      result.errors = errors;
      result.warnings = [...new Set([...result.warnings, ...warnings])].slice(
        0,
        30,
      );
      result.runId = runId;
      const finishedAt = new Date().toISOString();
      this.store.db
        .prepare(
          "UPDATE sources SET status=?,lastSyncAt=?,lastError=?,lastResult=? WHERE id=?",
        )
        .run(
          errors ? "error" : "connected",
          finishedAt,
          errors ? `Не удалось нормализовать записей: ${errors}` : null,
          JSON.stringify(result),
          id,
        );
      this.store.db
        .prepare(
          "UPDATE sync_runs SET status=?,finishedAt=?,fetched=?,created=?,updated=?,duplicates=?,filtered=?,errors=?,warnings=? WHERE id=?",
        )
        .run(
          errors ? "partial" : "success",
          finishedAt,
          result.fetched,
          result.created,
          result.updated,
          result.duplicates,
          result.filtered,
          result.errors,
          JSON.stringify(result.warnings),
          runId,
        );
      return result;
    } catch (e) {
      const error = safeError(e);
      this.store.db
        .prepare("UPDATE sources SET status='error',lastError=? WHERE id=?")
        .run(error, id);
      if (!test)
        this.store.db
          .prepare(
            "UPDATE sync_runs SET status='error',finishedAt=?,errors=1,error=? WHERE id=?",
          )
          .run(new Date().toISOString(), error, runId);
      throw new Error(error);
    } finally {
      this.busy = false;
    }
  }
  async plan(id: string, input: unknown = {}): Promise<SyncPlan> {
    const source = this.store.source(id),
      provider = getProvider(source.providerId),
      ctx = {
        source,
        scope: this.store.scope(source.scopeId),
        secrets: readSecrets(),
        store: this.store,
      },
      options = syncOptionsSchema.parse(input);
    const state = provider.connectionStatus(ctx);
    if (!state.canSync) throw new Error(state.message);
    if (!provider.planSync)
      return {
        sourceId: source.id,
        providerId: provider.id,
        title: `Синхронизация · ${source.name}`,
        summary: "Будет выполнен один ручной запрос к источнику.",
        requiresConfirmation: false,
        expectedRequests: 1,
        minimumRequests: 1,
        maximumRequests: 1,
        parameters: [],
        warnings: [],
      };
    let plan: SyncPlan;
    try {
      plan = await provider.planSync(ctx, options);
    } catch (caught) {
      const error = safeError(caught);
      this.store.db
        .prepare("UPDATE sources SET status='error',lastError=? WHERE id=?")
        .run(error, id);
      throw new Error(error);
    }
    if (provider.id === "allevents") {
      const known = this.store.estimateAllEvents(
        source.id,
        plan.startDate || "",
        plan.endDate || "",
        plan.categories || ["all"],
      );
      plan.knownItems = known;
    }
    return plan;
  }
  async all(scopeId: string) {
    const scope = this.store.scope(scopeId);
    const eligible = this.views().filter(
      (s) =>
        s.connection.canSync &&
        s.provider.group === "API Агрегаторы" &&
        !s.provider.manualSyncOnly &&
        (scope.city
          ? s.scopeId === scopeId
          : this.store.scope(s.scopeId).country === scope.country),
    );
    const results = [];
    for (const s of eligible) {
      try {
        results.push({
          sourceId: s.id,
          sourceName: s.name,
          result: await this.run(s.id),
        });
      } catch (e) {
        results.push({
          sourceId: s.id,
          sourceName: s.name,
          error: safeError(e),
        });
      }
    }
    return results;
  }
  runs(): SyncRun[] {
    return (
      this.store.db
        .prepare(
          "SELECT r.*,s.name AS sourceName FROM sync_runs r JOIN sources s ON s.id=r.sourceId ORDER BY startedAt DESC LIMIT 40",
        )
        .all() as any[]
    ).map((r) => ({ ...r, warnings: JSON.parse(r.warnings) }));
  }
}

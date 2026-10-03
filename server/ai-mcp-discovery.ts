import type { Express } from "express";
import { z } from "zod";
import {
  discoveryQueriesInputSchema,
  discoverySummaryInputSchema,
  type DiscoveryQueriesInput,
  type DiscoveryQueryEvidence,
  type DiscoveryQueryPending,
  type DiscoveryQuerySnapshot,
  type DiscoverySummaryInput,
} from "../shared/ai-mcp-discovery.js";
import type { EventPreferenceSummary } from "../shared/ai-events-review.js";
import { AiEventsReview } from "./ai-events-review.js";
import { digest } from "./normalize.js";
import { googlePlacesQuotaStatus } from "./providers/google-places/quota.js";
import type { Store } from "./store.js";

type QueryReceipt = { queryId: string; snapshot: DiscoveryQuerySnapshot };

export class AiMcpDiscovery {
  constructor(private store: Store) {}

  summary(): EventPreferenceSummary {
    return this.store.db
      .prepare(
        "SELECT summary,revision,updatedAt FROM ai_mcp_discovery_summary WHERE id='main'",
      )
      .get() as unknown as EventPreferenceSummary;
  }

  evidence(): DiscoveryQueryEvidence[] {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM ai_mcp_discovery_evidence ORDER BY summaryRevision,queryId",
      )
      .all() as unknown as Array<
      Omit<DiscoveryQueryEvidence, "snapshot"> & { snapshot: string }
    >;
    return rows.map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
  }

  // Provider-native logs are read in place, so old searches become evidence too.
  history(): QueryReceipt[] {
    const receipts: QueryReceipt[] = this.store.db
      .prepare(
        "SELECT queryId,snapshot FROM ai_mcp_discovery_query_history ORDER BY queryId",
      )
      .all()
      .map((row) => ({
        queryId: `recorded:${row.queryId}`,
        snapshot: JSON.parse(row.snapshot as string),
      }));
    for (const row of this.store.db
      .prepare("SELECT * FROM telegram_query_history")
      .all()) {
      receipts.push({
        queryId: `telegram:${row.id}`,
        snapshot: {
          providerId: "telegram",
          operation: row.operation as string,
          query: row.query as string,
          scopeId: "",
          runId: row.runId as string,
          executedAt: row.executedAt as string,
          outcome: "success",
          returnedCount: row.returnedCount as number,
          relevantCount: row.relevantCount as number | null,
          storedCount: row.storedCount as number,
          requestCount: null,
          costUsd: 0,
          parameters: {
            minParticipants: row.minParticipants as number,
            resultsPerQuery: row.resultsPerQuery as number,
          },
          notes: row.notes as string,
        },
      });
    }
    const sources = new Map(
      this.store.sources().map((source) => [source.id, source]),
    );
    // A reservation is not a completed search and must not teach a zero-yield rule.
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM google_places_api_usage WHERE outcome != 'reserved'",
      )
      .all()) {
      const source = sources.get(row.sourceId as string);
      receipts.push({
        queryId: `google-places:${row.id}`,
        snapshot: {
          providerId: "google-places-api",
          operation: `textSearch:${row.sku}`,
          query: row.query as string,
          scopeId: source?.scopeId || "",
          runId: null,
          executedAt: row.requestedAt as string,
          outcome: row.outcome as "success" | "error",
          returnedCount: row.resultCount as number,
          relevantCount: null,
          storedCount: null,
          requestCount: 1,
          costUsd: null,
          parameters: {
            sku: row.sku as string,
            billingMonth: row.billingMonth as string,
            weightUnits: row.weightUnits as number,
          },
          notes:
            row.outcome === "error"
              ? "Ошибка провайдера; это не доказательство неудачного ключевика."
              : "",
        },
      });
    }
    return receipts.sort(
      (a, b) =>
        a.snapshot.executedAt.localeCompare(b.snapshot.executedAt) ||
        a.queryId.localeCompare(b.queryId),
    );
  }

  pending(receipts = this.history()): DiscoveryQueryPending[] {
    const reviewed = new Map(
      this.evidence().map((item) => [item.queryId, item]),
    );
    return receipts.flatMap((item) => {
      const previous = reviewed.get(item.queryId);
      const fingerprint = digest(item.snapshot);
      return previous?.fingerprint === fingerprint
        ? []
        : [
            {
              ...item,
              fingerprint,
              previousConclusion: previous?.conclusion ?? null,
            },
          ];
    });
  }

  recordQueries(input: DiscoveryQueriesInput) {
    const data = discoveryQueriesInputSchema.parse(input);
    return this.store.transaction(() => {
      const seen = new Set<string>();
      for (const item of data.queries) {
        if (seen.has(item.queryId)) throw new Error("ID запроса повторяется");
        seen.add(item.queryId);
        const previous = this.store.db
          .prepare(
            "SELECT snapshot FROM ai_mcp_discovery_query_history WHERE queryId=?",
          )
          .get(item.queryId);
        if (previous) {
          const identity = (value: DiscoveryQuerySnapshot) => ({
            providerId: value.providerId,
            operation: value.operation,
            query: value.query,
            scopeId: value.scopeId,
            runId: value.runId,
            executedAt: value.executedAt,
            parameters: value.parameters,
          });
          if (
            digest(identity(JSON.parse(previous.snapshot as string))) !==
            digest(identity(item.snapshot))
          )
            throw new Error(
              "ID уже принадлежит другому запросу; используйте новый ID",
            );
        }
        this.store.db
          .prepare(
            "INSERT INTO ai_mcp_discovery_query_history(queryId,snapshot,updatedAt) VALUES (?,?,?) ON CONFLICT(queryId) DO UPDATE SET snapshot=excluded.snapshot,updatedAt=excluded.updatedAt",
          )
          .run(
            item.queryId,
            JSON.stringify(item.snapshot),
            new Date().toISOString(),
          );
      }
      return {
        recorded: data.queries.length,
        queryIds: data.queries.map((item) => `recorded:${item.queryId}`),
      };
    });
  }

  saveSummary(input: DiscoverySummaryInput) {
    const data = discoverySummaryInputSchema.parse(input);
    return this.store.transaction(() => {
      if (this.summary().revision !== data.expectedRevision)
        throw new Error("Discovery summary изменился; перечитайте контекст");
      const pending = new Map(
        this.pending().map((item) => [item.queryId, item]),
      );
      const seen = new Set<string>();
      const revision = data.expectedRevision + 1;
      const updatedAt = new Date().toISOString();
      for (const item of data.evidence) {
        if (seen.has(item.queryId)) throw new Error("ID запроса повторяется");
        seen.add(item.queryId);
        const current = pending.get(item.queryId);
        if (!current || current.fingerprint !== item.fingerprint)
          throw new Error("Результат запроса изменился; перечитайте контекст");
        this.store.db
          .prepare(
            "INSERT INTO ai_mcp_discovery_evidence(queryId,fingerprint,snapshot,conclusion,summaryRevision,reviewedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(queryId) DO UPDATE SET fingerprint=excluded.fingerprint,snapshot=excluded.snapshot,conclusion=excluded.conclusion,summaryRevision=excluded.summaryRevision,reviewedAt=excluded.reviewedAt",
          )
          .run(
            item.queryId,
            item.fingerprint,
            JSON.stringify(current.snapshot),
            item.conclusion,
            revision,
            updatedAt,
          );
      }
      this.store.db
        .prepare(
          "UPDATE ai_mcp_discovery_summary SET summary=?,revision=?,updatedAt=? WHERE id='main'",
        )
        .run(data.summary, revision, updatedAt);
      return this.summary();
    });
  }

  keywordStats(receipts = this.history()) {
    const groups = new Map<
      string,
      {
        providerId: string;
        operation: string;
        query: string;
        scopeId: string;
        parameters: DiscoveryQuerySnapshot["parameters"];
        attempts: number;
        errors: number;
        successfulAttempts: number;
        countedAttempts: number;
        storedCountedAttempts: number;
        assessedAttempts: number;
        returnedCount: number;
        relevantCount: number;
        assessedReturnedCount: number;
        storedCount: number;
        lastExecutedAt: string;
      }
    >();
    for (const { snapshot: item } of receipts) {
      // Scope/operation/parameters matter: a Pro search is not an IDs-only search.
      const identity = {
        providerId: item.providerId,
        operation: item.operation,
        query: item.query,
        scopeId: item.scopeId,
        parameters: item.parameters,
      };
      const key = digest(identity);
      const stats = groups.get(key) || {
        ...identity,
        attempts: 0,
        errors: 0,
        successfulAttempts: 0,
        countedAttempts: 0,
        storedCountedAttempts: 0,
        assessedAttempts: 0,
        returnedCount: 0,
        relevantCount: 0,
        assessedReturnedCount: 0,
        storedCount: 0,
        lastExecutedAt: item.executedAt,
      };
      stats.attempts++;
      if (item.outcome === "error") stats.errors++;
      if (item.outcome === "success") {
        stats.successfulAttempts++;
        if (item.returnedCount !== null) {
          stats.countedAttempts++;
          stats.returnedCount += item.returnedCount;
        }
        if (item.storedCount !== null) {
          stats.storedCountedAttempts++;
          stats.storedCount += item.storedCount;
        }
        if (item.relevantCount !== null && item.returnedCount !== null) {
          stats.assessedAttempts++;
          stats.relevantCount += item.relevantCount;
          stats.assessedReturnedCount += item.returnedCount;
        }
      }
      if (item.executedAt > stats.lastExecutedAt)
        stats.lastExecutedAt = item.executedAt;
      groups.set(key, stats);
    }
    return [...groups.values()]
      .map((item) => ({
        ...item,
        returnedCount: item.countedAttempts ? item.returnedCount : null,
        relevantCount: item.assessedAttempts ? item.relevantCount : null,
        storedCount: item.storedCountedAttempts ? item.storedCount : null,
        relevanceRate:
          item.assessedReturnedCount > 0
            ? item.relevantCount / item.assessedReturnedCount
            : null,
      }))
      .sort(
        (a, b) =>
          (b.relevanceRate ?? -1) - (a.relevanceRate ?? -1) ||
          (b.relevantCount ?? 0) - (a.relevantCount ?? 0) ||
          a.query.localeCompare(b.query),
      );
  }

  context(scopeId = "belgrade", limit = 200) {
    const preferences = new AiEventsReview(this.store);
    const history = this.history();
    const pending = this.pending(history);
    return {
      scope: this.store.scope(scopeId),
      now: new Date().toISOString(),
      profile: this.store.profile(),
      preferenceSummary: preferences.summary(),
      reviewedFeedback: preferences.evidence(),
      pendingFeedback: preferences.pending(),
      querySummary: this.summary(),
      reviewedQueries: this.evidence(),
      pendingQueries: pending.slice(0, limit),
      pendingQueryCount: pending.length,
      queryCount: history.length,
      keywordStats: this.keywordStats(history),
      quota: {
        googlePlaces: googlePlacesQuotaStatus(this.store),
        note: "Только локально зарегистрированное использование. Баланс/квота Apify здесь неизвестны; проверяйте доступный status/кабинет без запуска actor.",
      },
    };
  }
}

export function registerAiMcpDiscoveryApi(app: Express, store: Store) {
  const discovery = new AiMcpDiscovery(store);
  const querySchema = z
    .object({
      scopeId: z.string().min(1).default("belgrade"),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    })
    .strict();
  app.get("/api/ai-mcp-discovery/context", (req, res) => {
    const query = querySchema.parse(req.query);
    res.json(discovery.context(query.scopeId, query.limit));
  });
  app.post("/api/ai-mcp-discovery/queries", (req, res) =>
    res.json(discovery.recordQueries(req.body)),
  );
  app.put("/api/ai-mcp-discovery/summary", (req, res) =>
    res.json(discovery.saveSummary(req.body)),
  );
}

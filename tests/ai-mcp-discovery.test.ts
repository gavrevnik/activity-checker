import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";
import { AiMcpDiscovery } from "../server/ai-mcp-discovery.js";
import { AiEventsReview } from "../server/ai-events-review.js";
import {
  reserveGooglePlacesRequest,
  finishGooglePlacesRequest,
} from "../server/providers/google-places/quota.js";
import type { DiscoveryQueriesInput } from "../shared/ai-mcp-discovery.js";

let store: Store;
let discovery: AiMcpDiscovery;
beforeEach(() => {
  store = new Store(":memory:");
  discovery = new AiMcpDiscovery(store);
});
afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

function receipt(
  queryId = "run-one:query-one",
  changes: Partial<DiscoveryQueriesInput["queries"][number]["snapshot"]> = {},
) {
  return {
    queryId,
    snapshot: {
      providerId: "instagram",
      operation: "search",
      query: "belgrade wine tasting",
      scopeId: "belgrade",
      executedAt: "2026-10-02T12:00:00Z",
      outcome: "success" as const,
      returnedCount: 10,
      relevantCount: 3,
      storedCount: 2,
      ...changes,
    },
  };
}
function savePending() {
  return discovery.saveSummary({
    expectedRevision: discovery.summary().revision,
    summary:
      "Instagram: wine tasting — 3 релевантных из 10, пока небольшая выборка.",
    evidence: discovery.pending().map((item) => ({
      queryId: item.queryId,
      fingerprint: item.fingerprint,
      conclusion: "Результат учтён с оговоркой о размере выборки.",
    })),
  });
}
function telegram(id: string, query: string, relevant: number | null = null) {
  store.db
    .prepare(
      "INSERT INTO telegram_query_history(id,runId,executedAt,operation,query,resultsPerQuery,returnedCount,relevantCount,storedCount) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      "tg-run",
      "2026-10-01T12:00:00Z",
      "searchPublicChats",
      query,
      10,
      5,
      relevant,
      0,
    );
}

describe("AI MCP discovery memory", () => {
  it("creates separate empty query memory, without changing preference memory or spending quota", () => {
    const network = vi.spyOn(globalThis, "fetch");
    const context = discovery.context();
    expect(context.querySummary).toMatchObject({ summary: "", revision: 0 });
    expect(context.preferenceSummary).toMatchObject({
      summary: "",
      revision: 0,
    });
    expect(context.pendingQueries).toEqual([]);
    expect(context.quota.googlePlaces.bySku.pro.used).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });

  it("exposes the shared profile and explicit feedback reasons, without archiving or creating a second preference summary", () => {
    store.ingest(store.source("source-manual"), [
      {
        entity: { type: "Event", title: "Old concert", startAt: "2000-01-01" },
        raw: { externalId: "old", url: "", rawText: "", payload: {} },
      },
    ]);
    const event = store
      .entities({ includeFiltered: true })
      .find((item) => item.title === "Old concert")!;
    store.setState(event.id, {
      reaction: "dislike",
      dislikeReason: "Слишком поздно, не жанр",
    });
    const context = discovery.context();
    expect(context.profile).toEqual(store.profile());
    expect(context.pendingFeedback[0].snapshot.dislikeReason).toBe(
      "Слишком поздно, не жанр",
    );
    expect(store.entitySummary(event.id).archived).toBe(false);
    const review = new AiEventsReview(store);
    review.saveSummary({
      expectedRevision: 0,
      summary: "Позднее время неудобно, жанр не отвергнут.",
      evidence: context.pendingFeedback.map((item) => ({
        eventId: item.eventId,
        fingerprint: item.fingerprint,
        conclusion: "Причина — время, не музыкальный вкус.",
      })),
    });
    expect(discovery.context().preferenceSummary.revision).toBe(1);
    expect(discovery.context().pendingFeedback).toEqual([]);
    expect(discovery.summary().revision).toBe(0);
  });

  it("includes old native Telegram searches and revisits changed relevance marking", () => {
    telegram("old-search", "python belgrade");
    expect(discovery.pending()[0]).toMatchObject({
      queryId: "telegram:old-search",
      snapshot: { relevantCount: null, scopeId: "" },
    });
    savePending();
    expect(discovery.pending()).toEqual([]);
    store.db
      .prepare(
        "UPDATE telegram_query_history SET relevantCount=4,storedCount=3 WHERE id=?",
      )
      .run("old-search");
    expect(discovery.pending()[0]).toMatchObject({
      queryId: "telegram:old-search",
      previousConclusion: expect.any(String),
      snapshot: { relevantCount: 4, storedCount: 3 },
    });
    savePending();
    expect(discovery.pending()).toEqual([]);
    expect(discovery.evidence()).toHaveLength(1);
  });

  it("reads completed Google receipts, excludes reservations and keeps actual per-SKU quota", () => {
    const pro = reserveGooglePlacesRequest(
      store,
      "pro",
      "wine bars",
      "source-google-places-api",
    );
    expect(discovery.pending()).toEqual([]);
    expect(discovery.context().quota.googlePlaces.bySku.pro.used).toBe(1);
    finishGooglePlacesRequest(store, pro.id, "success", 8);
    const ids = reserveGooglePlacesRequest(store, "ids_only", "wine bars");
    finishGooglePlacesRequest(store, ids.id, "error", 0, "test error");
    expect(discovery.pending()).toHaveLength(2);
    expect(
      discovery
        .pending()
        .find((item) => item.queryId === `google-places:${pro.id}`)?.snapshot,
    ).toMatchObject({
      relevantCount: null,
      returnedCount: 8,
      requestCount: 1,
      operation: "textSearch:pro",
    });
    expect(
      discovery.keywordStats().every((item) => item.relevanceRate === null),
    ).toBe(true);
    expect(
      discovery.keywordStats().every((item) => item.relevantCount === null),
    ).toBe(true);
    expect(
      discovery.keywordStats().every((item) => item.storedCount === null),
    ).toBe(true);
    expect(
      discovery
        .keywordStats()
        .find((item) => item.operation === "textSearch:ids_only")?.errors,
    ).toBe(1);
    savePending();
    expect(discovery.pending()).toEqual([]);
    expect(discovery.context().quota.googlePlaces.bySku.pro.used).toBe(1);
  });

  it("records generic receipts idempotently and detects corrected metrics", () => {
    const item = receipt();
    discovery.recordQueries({ queries: [item] });
    discovery.recordQueries({ queries: [item] });
    expect(discovery.history()).toHaveLength(1);
    savePending();
    discovery.recordQueries({
      queries: [
        receipt(item.queryId, {
          relevantCount: 2,
          notes: "Один вариант оказался дублем/неподходящим.",
        }),
      ],
    });
    expect(discovery.pending()).toHaveLength(1);
    expect(discovery.pending()[0].previousConclusion).not.toBeNull();
    savePending();
    expect(discovery.evidence()).toHaveLength(1);
  });

  it("rejects reused IDs for different searches and rolls back a whole receipt batch", () => {
    discovery.recordQueries({ queries: [receipt()] });
    expect(() =>
      discovery.recordQueries({
        queries: [receipt("new"), receipt(undefined, { query: "other query" })],
      }),
    ).toThrow("другому запросу");
    expect(discovery.history()).toHaveLength(1);
    expect(() =>
      discovery.recordQueries({
        queries: [receipt("repeat"), receipt("repeat")],
      }),
    ).toThrow("повторяется");
    expect(discovery.history()).toHaveLength(1);
  });

  it("keeps unassessed search yield separate from known relevance rates", () => {
    discovery.recordQueries({
      queries: [
        receipt("reviewed"),
        receipt("unknown", {
          executedAt: "2026-10-03T12:00:00Z",
          returnedCount: 90,
          relevantCount: null,
        }),
        receipt("error", {
          outcome: "error",
          relevantCount: 0,
          returnedCount: 0,
          storedCount: 0,
        }),
      ],
    });
    expect(discovery.keywordStats()[0]).toMatchObject({
      attempts: 3,
      successfulAttempts: 2,
      errors: 1,
      assessedAttempts: 1,
      assessedReturnedCount: 10,
      relevanceRate: 0.3,
    });
  });

  it("does not mix providers, operations, geography or filter parameters", () => {
    discovery.recordQueries({
      queries: [
        receipt("a"),
        receipt("b", { providerId: "telegram" }),
        receipt("c", { operation: "recommendations" }),
        receipt("d", { scopeId: "serbia" }),
        receipt("e", { parameters: { minParticipants: 1000 } }),
      ],
    });
    expect(discovery.keywordStats()).toHaveLength(5);
  });

  it("atomically saves summary/evidence and rejects stale revision, stale fingerprints and duplicate IDs", () => {
    discovery.recordQueries({ queries: [receipt("a"), receipt("b")] });
    const evidence = discovery.pending().map((item) => ({
      queryId: item.queryId,
      fingerprint: item.fingerprint,
      conclusion: "Учтено",
    }));
    const input = { expectedRevision: 0, summary: "Итог", evidence };
    expect(() =>
      discovery.saveSummary({ ...input, expectedRevision: 1 }),
    ).toThrow("изменился");
    expect(() =>
      discovery.saveSummary({ ...input, evidence: [evidence[0], evidence[0]] }),
    ).toThrow("повторяется");
    discovery.recordQueries({ queries: [receipt("b", { relevantCount: 1 })] });
    expect(() => discovery.saveSummary(input)).toThrow("изменился");
    expect(discovery.evidence()).toEqual([]);
    expect(discovery.summary().revision).toBe(0);
    savePending();
    expect(discovery.summary().revision).toBe(1);
    expect(() => discovery.saveSummary(input)).toThrow("изменился");
  });

  it("drains a large pending queue in successive context-limited batches", () => {
    discovery.recordQueries({
      queries: [receipt("a"), receipt("b"), receipt("c")],
    });
    let expected = 3;
    while (expected) {
      const context = discovery.context("belgrade", 1);
      expect(context.pendingQueryCount).toBe(expected--);
      expect(context.pendingQueries).toHaveLength(1);
      discovery.saveSummary({
        expectedRevision: context.querySummary.revision,
        summary: "Последовательное обновление",
        evidence: context.pendingQueries.map((item) => ({
          queryId: item.queryId,
          fingerprint: item.fingerprint,
          conclusion: "Учтено",
        })),
      });
    }
    expect(discovery.pending()).toEqual([]);
    expect(discovery.evidence()).toHaveLength(3);
  });

  it("validates receipt counters and strict payloads", () => {
    expect(() =>
      discovery.recordQueries({
        queries: [receipt("bad", { relevantCount: 11 })],
      }),
    ).toThrow();
    expect(() =>
      discovery.recordQueries({
        queries: [receipt("bad", { storedCount: -1 })],
      }),
    ).toThrow();
    expect(() =>
      discovery.recordQueries({
        queries: [{ ...receipt(), execute: true } as any],
      }),
    ).toThrow();
    expect(() =>
      discovery.saveSummary({ expectedRevision: 0, summary: "", evidence: [] }),
    ).toThrow();
  });

  it("persists receipts and evidence across database reopen in a temporary directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "activity-discovery-test-"));
    const path = join(directory, "test.sqlite");
    let temporary: Store | undefined;
    try {
      temporary = new Store(path);
      const first = new AiMcpDiscovery(temporary);
      first.recordQueries({ queries: [receipt()] });
      first.saveSummary({
        expectedRevision: 0,
        summary: "Stored strategy",
        evidence: first.pending().map((item) => ({
          queryId: item.queryId,
          fingerprint: item.fingerprint,
          conclusion: "Stored evidence",
        })),
      });
      temporary.close();
      temporary = new Store(path);
      const second = new AiMcpDiscovery(temporary);
      expect(second.summary().summary).toBe("Stored strategy");
      expect(second.evidence()).toHaveLength(1);
      expect(second.pending()).toEqual([]);
    } finally {
      temporary?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves context, receipts and guarded summary through the local HTTP API", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    server.on("request", createApi(store, address.port));
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/ai-mcp-discovery${path}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      return { status: response.status, body: (await response.json()) as any };
    };
    try {
      expect((await request("/context")).status).toBe(200);
      expect(
        (await request("/queries", "POST", { queries: [receipt()] })).status,
      ).toBe(200);
      const context = (await request("/context?limit=1")).body;
      const evidence = context.pendingQueries.map((item: any) => ({
        queryId: item.queryId,
        fingerprint: item.fingerprint,
        conclusion: "Useful wording",
      }));
      expect(
        (
          await request("/summary", "PUT", {
            expectedRevision: 0,
            summary: "Working keywords",
            evidence,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request("/summary", "PUT", {
            expectedRevision: 0,
            summary: "Stale",
            evidence,
          })
        ).status,
      ).toBe(400);
      expect((await request("/context?limit=99999")).status).toBe(400);
      const final = (await request("/context")).body;
      expect(final.pendingQueryCount).toBe(0);
      expect(final.querySummary.revision).toBe(1);
      expect(final.preferenceSummary.revision).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

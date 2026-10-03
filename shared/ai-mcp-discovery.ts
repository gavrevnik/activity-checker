import { z } from "zod";

const count = z.number().int().min(0).nullable().default(null);
export const discoveryQuerySnapshotSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    operation: z.string().trim().min(1).max(150),
    query: z.string().trim().min(1).max(6500),
    scopeId: z.string().max(100).default(""),
    runId: z.string().max(200).nullable().default(null),
    executedAt: z.iso.datetime({ offset: true }),
    outcome: z.enum(["success", "error", "unknown"]),
    returnedCount: count,
    relevantCount: count,
    storedCount: count,
    requestCount: count,
    costUsd: z.number().min(0).nullable().default(null),
    parameters: z
      .record(
        z.string().min(1).max(100),
        z.union([
          z.string().max(500),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .default({}),
    notes: z.string().trim().max(2000).default(""),
  })
  .strict()
  .refine(
    (value) =>
      value.returnedCount === null ||
      ((value.relevantCount === null ||
        value.relevantCount <= value.returnedCount) &&
        (value.storedCount === null ||
          value.storedCount <= value.returnedCount)),
    "Число релевантных/сохранённых результатов не может превышать число полученных",
  );

export type DiscoveryQuerySnapshot = z.output<
  typeof discoveryQuerySnapshotSchema
>;
export const discoveryQueriesInputSchema = z
  .object({
    queries: z
      .array(
        z
          .object({
            queryId: z.string().trim().min(1).max(200),
            snapshot: discoveryQuerySnapshotSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type DiscoveryQueriesInput = z.input<typeof discoveryQueriesInputSchema>;

export const discoverySummaryInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    summary: z.string().trim().min(1).max(5000),
    evidence: z
      .array(
        z
          .object({
            queryId: z.string().min(1).max(300),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            conclusion: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type DiscoverySummaryInput = z.input<typeof discoverySummaryInputSchema>;
export interface DiscoveryQueryEvidence {
  queryId: string;
  fingerprint: string;
  snapshot: DiscoveryQuerySnapshot;
  conclusion: string;
  summaryRevision: number;
  reviewedAt: string;
}
export interface DiscoveryQueryPending {
  queryId: string;
  fingerprint: string;
  snapshot: DiscoveryQuerySnapshot;
  previousConclusion: string | null;
}

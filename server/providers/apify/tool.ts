import { z } from "zod";
import { entitySchema } from "../../../shared/model.js";
import { readSecrets } from "../../secrets.js";
import {
  apifyConfigs,
  apifyCost,
  apifyProviderIds,
  checkApifyToken,
  compactApifyItem,
  executeApifyBatch,
} from "./client.js";
import { apifyRawItem } from "./providers.js";

export const apifyToolInputSchema = z
  .object({
    providerId: z.enum(apifyProviderIds),
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
    resultsPerQuery: z.number().int().min(1).max(100).default(10),
    maxItems: z.number().int().min(1).max(500).default(100),
    execute: z.boolean().default(false),
    testMode: z.boolean().default(false),
    store: z.boolean().default(false),
    sourceId: z.string().min(1).max(200).optional(),
  })
  .strict();

function requiredToken() {
  const token = readSecrets().APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN не найден в .env.local.");
  return token;
}

export async function getApifyToolStatus() {
  return { ok: true, username: await checkApifyToken(requiredToken()) };
}

export async function executeApifyTool(
  input: z.input<typeof apifyToolInputSchema>,
) {
  const args = apifyToolInputSchema.parse(input);
  const config = apifyConfigs[args.providerId];
  const possibleItems = Math.min(
    args.maxItems,
    args.queries.length * args.resultsPerQuery,
  );
  const plannedItems = args.testMode
    ? Math.min(possibleItems, 2)
    : possibleItems;
  const plan = {
    providerId: args.providerId,
    actor: config.actor.replace("~", "/"),
    queryCount: args.queries.length,
    resultsPerQuery: args.resultsPerQuery,
    maxItems: plannedItems,
    maxChargeUsd: apifyCost(args.providerId, plannedItems),
    paid: true,
  };
  if (!args.execute) {
    if (args.store)
      throw new Error("store=true доступен только вместе с execute=true.");
    return { mode: "dry-run" as const, plan, items: [], stored: null };
  }
  const result = await executeApifyBatch({
    providerId: args.providerId,
    queries: args.queries,
    token: requiredToken(),
    resultsPerQuery: args.resultsPerQuery,
    maxItems: args.maxItems,
    testMode: args.testMode,
  });
  let stored = null;
  if (args.store) {
    const { Store } = await import("../../store.js");
    const store = new Store();
    try {
      const source = store.source(args.sourceId || `source-${args.providerId}`);
      if (source.providerId !== args.providerId)
        throw new Error("sourceId не соответствует выбранному Apify provider.");
      const ctx = {
        source,
        scope: store.scope(source.scopeId),
        secrets: { APIFY_TOKEN: requiredToken() },
      };
      stored = store.ingest(
        source,
        result.items.map((item) => {
          const raw = apifyRawItem(args.providerId, item, ctx);
          return {
            raw,
            entity: entitySchema.parse(
              (raw.payload as { normalized: unknown }).normalized,
            ),
          };
        }),
      );
    } finally {
      store.close();
    }
  }
  return {
    mode: "executed" as const,
    plan: {
      ...plan,
      maxItems: result.maxItems,
      maxChargeUsd: result.maxChargeUsd,
    },
    items: result.items.map(compactApifyItem),
    stored,
  };
}

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readSecrets, safeError } from "../server/secrets.js";
import {
  apifyConfigs,
  apifyCost,
  apifyProviderIds,
  compactApifyItem,
  executeApifyBatch,
  normalizeQueries,
  type ApifyProviderId,
} from "../server/providers/apify/client.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function argumentsFor(name: string) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );
}
function integer(name: string, fallback: number) {
  const raw = argument(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name}: нужно положительное целое число.`);
  return parsed;
}
function usage() {
  console.log(`Apify discovery tool

Dry-run (free):
  npm run apify:tool -- --provider instagram --query "squash belgrade" --query "squash serbia"

Paid execution after reviewing the estimate:
  npm run apify:tool -- --provider instagram --query "squash club belgrade" --max-items 10 --execute

Save the returned dataset for review before selective import:
  npm run apify:tool -- --provider instagram --query "hiking serbia" --max-items 10 --execute --raw --output data/instagram-discovery.json

Live tool test (hard-capped to 2 billed results):
  npm run apify:tool -- --provider instagram --query "squash club belgrade" --test-live --execute

Providers: instagram, facebook-apify, google-places. Up to 30 --query values are batched into exactly one Actor run.`);
}

async function main() {
  if (process.argv.includes("--help")) return usage();
  const datasetId = argument("--dataset");
  if (datasetId) {
    if (!/^[A-Za-z0-9]+$/.test(datasetId))
      throw new Error("Некорректный dataset ID.");
    const token = readSecrets().APIFY_TOKEN;
    if (!token) throw new Error("APIFY_TOKEN не найден в .env.local.");
    const limit = Math.min(integer("--limit", 2), 500);
    const response = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=${limit}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Apify ответил HTTP ${response.status}.`);
    const items = (await response.json()) as unknown[];
    const outputItems = process.argv.includes("--raw")
      ? items
      : items.map(compactApifyItem);
    const payload = {
      mode: "dataset",
      datasetId,
      returned: items.length,
      items: outputItems,
    };
    const outputPath = argument("--output");
    if (outputPath) {
      const absolutePath = resolve(outputPath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      console.log(
        JSON.stringify(
          {
            mode: "dataset",
            datasetId,
            returned: items.length,
            output: absolutePath,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (process.argv.includes("--recent-runs")) {
    const token = readSecrets().APIFY_TOKEN;
    if (!token) throw new Error("APIFY_TOKEN не найден в .env.local.");
    const response = await fetch(
      "https://api.apify.com/v2/actor-runs?desc=1&limit=5",
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Apify ответил HTTP ${response.status}.`);
    const payload = (await response.json()) as {
      data?: {
        items?: Array<Record<string, unknown>>;
      };
    };
    const runs = (payload.data?.items || []).map((run) => ({
      id: run.id,
      actId: run.actId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      defaultDatasetId: run.defaultDatasetId,
      usageTotalUsd: run.usageTotalUsd,
    }));
    console.log(JSON.stringify({ mode: "recent-runs", runs }, null, 2));
    return;
  }
  const providerId = argument("--provider") as ApifyProviderId | undefined;
  if (!providerId || !apifyProviderIds.includes(providerId)) {
    usage();
    throw new Error("Укажите поддерживаемый --provider.");
  }
  const config = apifyConfigs[providerId];
  const queries = normalizeQueries(argumentsFor("--query"));
  if (!queries.length) throw new Error("Добавьте хотя бы один --query.");
  const testMode = process.argv.includes("--test-live");
  const resultsPerQuery = testMode
    ? Math.min(integer("--results-per-query", 2), 2)
    : Math.min(
        integer("--results-per-query", config.defaultResultsPerQuery),
        100,
      );
  const possible = queries.length * resultsPerQuery;
  const maxItems = testMode
    ? Math.min(integer("--max-items", 2), 2)
    : Math.min(integer("--max-items", config.defaultMaxItems), possible, 500);
  const estimate = {
    provider: providerId,
    actor: config.actor.replace("~", "/"),
    actorRuns: 1,
    queryCount: queries.length,
    queries,
    resultsPerQuery,
    maxItems,
    maxChargeUsd: apifyCost(providerId, maxItems),
    testMode,
  };
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ mode: "dry-run", ...estimate }, null, 2));
    return;
  }
  const token = readSecrets().APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN не найден в .env.local.");
  const result = await executeApifyBatch({
    providerId,
    queries,
    token,
    resultsPerQuery,
    maxItems,
    testMode,
  });
  const payload = {
    mode: testMode ? "test-live" : "execute",
    ...estimate,
    returned: result.items.length,
    items: process.argv.includes("--raw")
      ? result.items
      : result.items.map(compactApifyItem),
  };
  const outputPath = argument("--output");
  if (outputPath) {
    const absolutePath = resolve(outputPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          ...estimate,
          mode: payload.mode,
          returned: result.items.length,
          output: absolutePath,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

await main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

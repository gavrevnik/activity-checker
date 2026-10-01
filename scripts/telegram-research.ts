import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeTelegramTool } from "../server/providers/telegram/tool.js";
import type { TelegramSearchResult } from "../server/providers/telegram/client.js";

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function keywords(path: string) {
  const input = JSON.parse(readFileSync(path, "utf8")) as {
    groups: Record<string, string[]>;
  };
  return Object.values(input.groups).flat();
}

const root = resolve(import.meta.dirname, "..");
const primary = keywords(
  resolve(
    root,
    argument("--keywords", "data/telegram-discovery-keywords-v2.json"),
  ),
);
const fallback = keywords(
  resolve(
    root,
    argument("--fallback", "data/telegram-discovery-keywords.json"),
  ),
);
const limit = Math.max(1, Math.min(Number(argument("--limit", "180")), 1000));
const minParticipants = Math.max(
  0,
  Number(argument("--min-participants", "500")),
);
const resultsPerQuery = Math.max(
  1,
  Math.min(Number(argument("--results-per-query", "5")), 50),
);
const outputPath = resolve(
  root,
  argument("--output", "data/telegram-discovery-latest.json"),
);
const selectedQueries = [
  ...new Set(
    [...primary, ...fallback].map((query) => query.trim()).filter(Boolean),
  ),
].slice(0, limit);
const results = new Map<string, TelegramSearchResult>();
const historyRunIds: string[] = [];
const warnings: string[] = [];
let requestCount = 0;

for (let index = 0; index < selectedQueries.length; index += 30) {
  const batch = selectedQueries.slice(index, index + 30);
  const response = await executeTelegramTool({
    queries: batch,
    operations: ["searchPublicChats"],
    seedChannels: [],
    resultsPerQuery,
    maxItems: Math.min(500, batch.length * resultsPerQuery),
    minParticipants,
    store: false,
  });
  requestCount += response.requestCount;
  historyRunIds.push(response.historyRunId);
  warnings.push(...response.warnings);
  for (const item of response.results) {
    const key = item.channel.username.toLowerCase();
    const current = results.get(key);
    if (!current) results.set(key, item);
    else {
      current.matchedQueries = [
        ...new Set([...current.matchedQueries, ...item.matchedQueries]),
      ];
      current.operations = [
        ...new Set([...current.operations, ...item.operations]),
      ];
    }
  }
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        queryCount: selectedQueries.length,
        completedQueries: Math.min(
          index + batch.length,
          selectedQueries.length,
        ),
        minParticipants,
        resultsPerQuery,
        requestCount,
        historyRunIds,
        warnings: [...new Set(warnings)],
        results: [...results.values()],
      },
      null,
      2,
    ) + "\n",
  );
  console.error(
    `Telegram research: ${Math.min(index + batch.length, selectedQueries.length)}/${selectedQueries.length} queries, ${results.size} unique channels.`,
  );
}

console.log(
  JSON.stringify(
    {
      queryCount: selectedQueries.length,
      requestCount,
      resultCount: results.size,
      historyRunIds,
      outputPath,
      warnings: [...new Set(warnings)],
    },
    null,
    2,
  ),
);

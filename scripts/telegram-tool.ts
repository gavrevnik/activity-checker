import { authorizeTelegramInteractive } from "../server/providers/telegram/client.js";
import {
  compactTelegramResult,
  executeTelegramTool,
  getTelegramQueryHistory,
  getTelegramToolStatus,
  markTelegramQueryHistory,
  sampleTelegramChannelPosts,
} from "../server/providers/telegram/tool.js";
import { readSecrets, safeError } from "../server/secrets.js";

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
function nonNegativeInteger(name: string, fallback: number) {
  const raw = argument(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${name}: нужно целое число от нуля.`);
  return parsed;
}
function usage() {
  console.log(`Telegram MTProto discovery tool

Setup and one-time login:
  npm run telegram:setup
  npm run telegram:auth

Connection status (does not search):
  npm run telegram:tool -- --status

Query effectiveness history:
  npm run telegram:tool -- --history

Sample recent public posts before storing a channel:
  npm run telegram:tool -- --sample-channel @channel \
    --sample-channel https://t.me/other --messages-per-channel 3

Dry-run plan (does not call Telegram):
  npm run telegram:tool -- --query "squash belgrade" --operation searchPublicChats

Execute one batch and return public results:
  npm run telegram:tool -- --query "squash belgrade" --query "сквош белград" \\
    --operation searchPublicChats --max-items 20 --execute

Filter channels with a known audience below 200:
  add --min-participants 200

Store normalized results in Activity Checker SQLite:
  add --store to an --execute call

Operations: searchPublicChats, channels.getChannelRecommendations.
Recommendations accept --seed https://t.me/channel. Post search is intentionally
disabled; use the separate Telegram monitoring MCP for channel history.
Up to 30 queries are executed sequentially in one authorized session.`);
}

async function main() {
  if (process.argv.includes("--help")) return usage();
  const secrets = readSecrets();
  if (process.argv.includes("--authorize")) {
    if (!secrets.TELEGRAM_API_ID || !secrets.TELEGRAM_API_HASH)
      throw new Error(
        "Добавьте TELEGRAM_API_ID и TELEGRAM_API_HASH в .env.local.",
      );
    await authorizeTelegramInteractive({
      apiId: secrets.TELEGRAM_API_ID,
      apiHash: secrets.TELEGRAM_API_HASH,
      pythonPath: secrets.TELEGRAM_PYTHON,
      sessionPath: secrets.TELEGRAM_SESSION_PATH,
    });
    return;
  }
  if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await getTelegramToolStatus(), null, 2));
    return;
  }
  if (process.argv.includes("--history")) {
    console.log(
      JSON.stringify(
        await getTelegramQueryHistory(integer("--limit", 200)),
        null,
        2,
      ),
    );
    return;
  }
  const markRun = argument("--mark-run");
  if (markRun) {
    console.log(
      JSON.stringify(
        await markTelegramQueryHistory({
          runId: markRun,
          relevantUsernames: argumentsFor("--relevant"),
          storedUsernames: argumentsFor("--stored-username"),
          notes: argument("--note") || "",
        }),
        null,
        2,
      ),
    );
    return;
  }
  const sampleChannels = argumentsFor("--sample-channel");
  if (sampleChannels.length) {
    console.log(
      JSON.stringify(
        await sampleTelegramChannelPosts({
          channels: sampleChannels,
          messagesPerChannel: Math.min(
            integer("--messages-per-channel", 3),
            10,
          ),
        }),
        null,
        2,
      ),
    );
    return;
  }
  const queries = argumentsFor("--query");
  const operations = argumentsFor("--operation");
  const seedChannels = argumentsFor("--seed");
  const selectedOperations = operations.length
    ? operations
    : ["searchPublicChats"];
  if (
    !queries.length &&
    !selectedOperations.includes("channels.getChannelRecommendations")
  ) {
    usage();
    throw new Error("Добавьте хотя бы один --query.");
  }
  const plan = {
    queries,
    operations: selectedOperations,
    seedChannels,
    resultsPerQuery: Math.min(integer("--results-per-query", 10), 50),
    maxItems: Math.min(integer("--max-items", 100), 500),
    minParticipants: Math.min(
      nonNegativeInteger("--min-participants", 0),
      10_000_000,
    ),
    store: process.argv.includes("--store"),
    sourceId: argument("--source") || "source-telegram",
  };
  if (!process.argv.includes("--execute")) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          ...plan,
          billing: "$0/result; automatic Stars payments are disabled",
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await executeTelegramTool(plan as never);
  console.log(JSON.stringify(compactTelegramResult(result), null, 2));
}

await main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

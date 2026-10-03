import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTelegramMonitoringChannels } from "../server/providers/telegram/tool.js";
import {
  telegramMonitoringResponseSchema,
  type TelegramMonitoringResponse,
} from "../server/providers/telegram/client.js";

// A manual, sequential run of the same MCP used by the assistant. Generated
// snapshots are private, ignored runtime data, never a general-event import.
const [startDate, endDate] = process.argv.slice(2);
if (!startDate || !endDate)
  throw new Error("Usage: telegram-monitoring-run.ts YYYY-MM-DD YYYY-MM-DD");
const selected = getTelegramMonitoringChannels({ limit: 1000 });
const client = new Client({
  name: "activity-checker-monitoring-run",
  version: "1",
});
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/telegram-monitoring-mcp.ts"],
    cwd: process.cwd(),
  }),
);
const batches: TelegramMonitoringResponse[] = [];
const outputPath = resolve(
  ".runtime",
  `telegram-monitoring-${startDate}-${endDate}.json`,
);
mkdirSync(resolve(".runtime"), { recursive: true });
try {
  for (let offset = 0; offset < selected.length; offset += 20) {
    const batch = selected.slice(offset, offset + 20);
    console.log(
      `Monitoring ${offset + 1}–${offset + batch.length}/${selected.length}`,
    );
    const response = await client.callTool(
      {
        name: "telegram_monitoring_posts",
        arguments: {
          communityIds: batch.map((channel) => channel.communityId),
          startDate,
          endDate,
          timeZone: "Europe/Belgrade",
          maxPostsPerChannel: 500,
          maxScannedPerChannel: 5000,
          pageSize: 100,
          delaySeconds: 5,
        },
      },
      undefined,
      { timeout: 900_000 },
    );
    const blocks = response.content as Array<{ type: string; text?: string }>;
    const body = blocks.find((block) => block.type === "text")?.text;
    if (response.isError || !body)
      throw new Error(body || "Monitoring MCP returned no response");
    const result = telegramMonitoringResponseSchema.parse(JSON.parse(body));
    batches.push(result);
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          startDate,
          endDate,
          selected,
          batches,
        },
        null,
        2,
      ),
    );
    for (const item of result.channels)
      console.log(
        JSON.stringify({
          username: item.channel.username,
          scanned: item.scannedCount,
          returned: item.returnedCount,
          filters: item.filterBreakdown,
          truncated: item.truncated,
        }),
      );
    console.log(JSON.stringify({ warnings: result.warnings }));
  }
  console.log(`Snapshot: ${outputPath}`);
} finally {
  await client.close();
}

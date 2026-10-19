import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { safeError } from "../server/secrets.js";

// A client-neutral bridge to the repository's actual MCP schemas and handlers.
// No global config, owner account or cloud connector is required.
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
let runtime: Record<string, string> = {};
try {
  runtime = parse(readFileSync(".env.local"));
} catch {}
const database = resolve(
  process.env.ACTIVITY_DB ||
    runtime.ACTIVITY_DB ||
    "../data/activity-checker/activity.sqlite",
);
const routes = {
  research: "scripts/activity-research-mcp.ts",
  telegram: "scripts/telegram-monitoring-mcp.ts",
} as const;
const [route, tool, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (
  !(route in routes) ||
  !tool ||
  args.some(
    (arg, index) =>
      !["--input", "--output"].includes(arg) &&
      !["--input", "--output"].includes(args[index - 1]),
  )
)
  throw Error(
    "Usage: local-tool.ts research|telegram --list|<tool> [--input file.json] [--output new-file.json]",
  );
const client = new Client({ name: "activity-checker-local-cli", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", routes[route as keyof typeof routes]],
  cwd: root,
  env: { ...process.env, ACTIVITY_DB: database } as Record<string, string>,
  stderr: "pipe",
});
try {
  await client.connect(transport);
  if (tool === "--list") {
    const result = await client.listTools();
    process.stdout.write(JSON.stringify({ route, tools: result.tools }) + "\n");
  } else {
    const input = option("--input");
    const parameters = JSON.parse(
      input ? readFileSync(input, "utf8") : readFileSync(0, "utf8") || "{}",
    );
    const result = await client.callTool(
      { name: tool, arguments: parameters },
      undefined,
      { timeout: 900_000 },
    );
    const blocks = Array.isArray(result.content)
      ? (result.content as Array<{ type: string; text?: string }>)
      : [];
    if (result.isError) {
      // The servers already redact credentials; do not dump arbitrary raw result blocks.
      throw Error(
        blocks
          .filter((block) => block.type === "text")
          .map((block) => ("text" in block ? block.text : ""))
          .join("\n") || "Local tool failed",
      );
    }
    const block = blocks.find((item) => item.type === "text");
    let body =
      result.structuredContent ??
      (block && "text" in block ? JSON.parse(String(block.text)) : {});
    if (
      tool === "telegram_monitoring_status" &&
      body &&
      typeof body === "object"
    ) {
      const status = body as Record<string, unknown>;
      body = { authorized: status.authorized === true };
    }
    const output = option("--output");
    if (output) {
      mkdirSync(dirname(resolve(output)), { recursive: true });
      writeFileSync(output, JSON.stringify(body, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(
        JSON.stringify({ saved: true, path: resolve(output) }) + "\n",
      );
    } else process.stdout.write(JSON.stringify(body) + "\n");
  }
} catch (error) {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
} finally {
  await client.close();
}

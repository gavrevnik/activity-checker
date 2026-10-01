import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  executeFoursquareTool,
  getFoursquareToolStatus,
} from "../server/providers/foursquare/tool.js";
import { safeError } from "../server/secrets.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const server = new McpServer(
  {
    name: "activity-checker-foursquare",
    version: "0.1.0",
  },
  {
    instructions:
      "Foursquare has a hard local limit of 500 API requests per calendar month. Call foursquare_status before planning. foursquare_search_places is a free dry run unless execute=true. Execute only when the user explicitly asks for a live search; each query costs one request. Never work around the local quota file or hard limit.",
  },
);

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: safeError(error) }],
  };
}

server.registerTool(
  "foursquare_status",
  {
    description:
      "Show whether the Foursquare key is configured and the locally tracked monthly quota. Does not call Foursquare.",
    inputSchema: {},
  },
  async () => response(getFoursquareToolStatus()),
);

server.registerTool(
  "foursquare_search_places",
  {
    description:
      "Plan or explicitly execute keyword place searches. Each query consumes one of 500 locally capped monthly requests; execute defaults to false.",
    inputSchema: {
      queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
      near: z.string().trim().min(1).max(200).default("Belgrade, Serbia"),
      resultsPerQuery: z.number().int().min(1).max(50).default(10),
      maxItems: z.number().int().min(1).max(500).default(100),
      execute: z.boolean().default(false),
      store: z.boolean().default(false),
    },
  },
  async (args) => {
    try {
      return response(await executeFoursquareTool(args));
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());

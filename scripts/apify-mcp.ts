import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  executeApifyTool,
  getApifyToolStatus,
} from "../server/providers/apify/tool.js";
import { safeError } from "../server/secrets.js";
import type { ApifyProviderId } from "../server/providers/apify/client.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const server = new McpServer({
  name: "activity-checker-apify",
  version: "0.1.0",
});

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
  "apify_status",
  {
    description:
      "Validate APIFY_TOKEN using the free account endpoint. Does not start an Actor.",
    inputSchema: {},
  },
  async () => {
    try {
      return response(await getApifyToolStatus());
    } catch (error) {
      return failure(error);
    }
  },
);

const common = {
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  resultsPerQuery: z.number().int().min(1).max(100).default(10),
  maxItems: z.number().int().min(1).max(500).default(100),
  execute: z
    .boolean()
    .default(false)
    .describe(
      "False returns a free plan; true starts a potentially paid Actor.",
    ),
  testMode: z
    .boolean()
    .default(false)
    .describe("Hard-cap an executed run to at most two paid results."),
  store: z
    .boolean()
    .default(false)
    .describe("Store normalized results in Activity Checker after execution."),
};

function registerSearch(
  name: string,
  providerId: ApifyProviderId,
  description: string,
) {
  server.registerTool(
    name,
    { description, inputSchema: common },
    async (args) => {
      try {
        return response(await executeApifyTool({ providerId, ...args }));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

registerSearch(
  "apify_instagram_search",
  "instagram",
  "Plan or explicitly execute one paid Instagram profile-search Actor batch.",
);
registerSearch(
  "apify_facebook_events_search",
  "facebook-apify",
  "Plan or explicitly execute one paid Facebook Events Actor batch.",
);
registerSearch(
  "apify_google_places_search",
  "google-places",
  "Plan or explicitly execute one paid Google Maps Places Actor batch.",
);

await server.connect(new StdioServerTransport());

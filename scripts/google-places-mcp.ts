import {
  withMcpBudget,
  mcpQuotaStatus,
} from "../server/providers/google-places/mcp-budget.js";
import { Store } from "../server/store.js";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  executeGooglePlacesDiscoveryTool,
  executeGooglePlacesTierTool,
  getGooglePlacesToolStatus,
  storeGooglePlacesLlmRatings,
} from "../server/providers/google-places/tool.js";
import { safeError } from "../server/secrets.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));

export const server = new McpServer(
  { name: "activity-checker-google-places", version: "0.1.0" },
  {
    instructions:
      "Before EVERY live Places run: read google_places_status, show today used/remaining and ask the user for a maximum number of HTTP requests for this run. Pass maxRequests (1–100); never reuse an earlier run budget. Daily hard cap 100 Europe/Belgrade shared by Basic/IDs-only and Pro, including failures. No Enterprise MCP tool. Use discovery_batch for new places; exclude only existing restaurant cards in Activity Checker (same restaurant classification as its UI). Takeout import and saved-list checks are paused at the user request; do not ask for exports or complain about missing lists. Matching uses place_id, CID/Maps URL and conservative exact normalized restaurant names. Discovery history alone does not make a place familiar. Do not claim complete novelty when data is insufficient. A smaller budget can stop between IDs and Pro; partial results are expected. Local Pro cards are saved automatically.",
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

const common = {
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  location: z.string().trim().min(1).max(200).optional(),
  minRating: z.number().min(0).max(5).multipleOf(0.5).optional(),
  resultsPerQuery: z.number().int().min(1).max(20).default(10),
  maxItems: z.number().int().min(1).max(500).default(100),
  execute: z.boolean().default(false),
  maxRequests: z.number().int().min(1).max(100).optional(),
  newOnly: z.boolean().default(true),
  sourceId: z.string().min(1).max(200).default("source-google-places-api"),
};

server.registerTool(
  "google_places_status",
  {
    description:
      "Read local Google Places monthly SKU counters, remaining local monthly capacity and the 100/day MCP budget, and discovered-ID counts. Does not call Google.",
    inputSchema: {},
  },
  async () => {
    try {
      const store = Store.openExisting(
        process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite",
      );
      try {
        return response({
          ...getGooglePlacesToolStatus(),
          dailyQuota: mcpQuotaStatus(),
          novelty: {scope: "activity_restaurant_cards", takeout: "paused"},
        });
      } finally {
        store.close();
      }
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "google_places_discovery_batch",
  {
    description:
      "Default place discovery: run budgeted IDs-only searches, skip known place IDs, then spend Pro requests only on productive queries. Enterprise is never used.",
    inputSchema: {
      ...common,
      minValidResultsPerQuery: z.number().int().min(1).max(20).default(1),
    },
  },
  async (args) => {
    try {
      const { maxRequests, ...input } = args;
      return response(
        await withMcpBudget(args.execute, maxRequests, () =>
          executeGooglePlacesDiscoveryTool(input),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "google_places_store_llm_ratings",
  {
    description:
      "Persist independently LLM-verified Google rating and review count for existing Place cards. Makes no Google API request and consumes no quota.",
    inputSchema: {
      items: z
        .array(
          z
            .object({
              placeId: z.string().trim().min(1).max(500),
              rating: z.number().min(0).max(5).optional(),
              reviewCount: z.number().int().min(0).optional(),
              source: z
                .string()
                .trim()
                .min(1)
                .max(2000)
                .default("LLM web research"),
              checkedAt: z.iso.datetime({ offset: true }).optional(),
            })
            .strict()
            .refine(
              (value) =>
                value.rating !== undefined || value.reviewCount !== undefined,
              "rating or reviewCount is required",
            ),
        )
        .min(1)
        .max(100),
    },
  },
  async (args) => {
    try {
      return response(storeGooglePlacesLlmRatings(args));
    } catch (error) {
      return failure(error);
    }
  },
);

function registerTier(
  name: string,
  mode: "ids_only" | "pro" | "enterprise",
  description: string,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: {
        ...common,
        confirmEnterprise: z.boolean().default(false),
      },
    },
    async (args) => {
      try {
        const { maxRequests, ...input } = args;
        return response(
          await withMcpBudget(args.execute, maxRequests, () =>
            executeGooglePlacesTierTool(mode, input),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

registerTier(
  "google_places_text_search_ids",
  "ids_only",
  "Text Search Essentials (IDs Only). Counts towards the 100 requests/day MCP cap; records place IDs for deduplication and returns only the ID-level response. It cannot create a Place card because names and coordinates are absent.",
);
registerTier(
  "google_places_text_search_pro",
  "pro",
  "Text Search Pro with stable Place-card fields: display name, address, coordinates, types, business status, and googleMapsUri. Executed results are saved as local Place cards. Local hard stop: 5,000 calls per Google billing month.",
);
if (process.argv[1] === fileURLToPath(import.meta.url))
  await server.connect(new StdioServerTransport());

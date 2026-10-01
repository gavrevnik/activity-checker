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

const server = new McpServer(
  { name: "activity-checker-google-places", version: "0.1.0" },
  {
    instructions:
      "Use google_places_discovery_batch by default: IDs-only first, then Pro only for productive queries with new place IDs. Never use Enterprise unless the user explicitly asks; an executed Enterprise call also requires confirmEnterprise=true. All live search tools are dry-run unless execute=true. Executed Pro results are stored as local Place cards. API ratings are not persisted; after independent LLM verification, save rating and reviewCount with google_places_store_llm_ratings. Check google_places_status before large batches.",
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
  sourceId: z.string().min(1).max(200).default("source-google-places-api"),
};

server.registerTool(
  "google_places_status",
  {
    description:
      "Read local Google Places monthly SKU counters, remaining Pro/Enterprise free-tier capacity, and discovered-ID counts. Does not call Google.",
    inputSchema: {},
  },
  async () => response(getGooglePlacesToolStatus()),
);

server.registerTool(
  "google_places_discovery_batch",
  {
    description:
      "Default place discovery: run unlimited IDs-only searches, skip known place IDs, then spend Pro requests only on productive queries. Enterprise is never used.",
    inputSchema: {
      ...common,
      minValidResultsPerQuery: z.number().int().min(1).max(20).default(1),
    },
  },
  async (args) => {
    try {
      return response(await executeGooglePlacesDiscoveryTool(args));
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
        return response(await executeGooglePlacesTierTool(mode, args));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

registerTier(
  "google_places_text_search_ids",
  "ids_only",
  "Text Search Essentials (IDs Only). Unlimited free usage cap; records place IDs for deduplication and returns only the ID-level response. It cannot create a Place card because names and coordinates are absent.",
);
registerTier(
  "google_places_text_search_pro",
  "pro",
  "Text Search Pro with stable Place-card fields: display name, address, coordinates, types, business status, and googleMapsUri. Executed results are saved as local Place cards. Local hard stop: 5,000 calls per Google billing month.",
);
registerTier(
  "google_places_text_search_enterprise",
  "enterprise",
  "Explicit-only Text Search Enterprise with all Pro and Enterprise fields, including rating and userRatingCount. Requires execute=true and confirmEnterprise=true. Local hard stop: 1,000 calls per billing month.",
);

await server.connect(new StdioServerTransport());

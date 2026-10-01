import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apifyCost,
  buildApifyInput,
  executeApifyBatch,
} from "../server/providers/apify/client";
import {
  apifyRawItem,
  facebook,
  instagram,
} from "../server/providers/apify/providers";
import { executeApifyTool } from "../server/providers/apify/tool";
import { Store } from "../server/store";
import instagramFixture from "./fixtures/apify-instagram-search.json";
import facebookFixture from "./fixtures/apify-facebook-events.json";

afterEach(() => vi.restoreAllMocks());

describe("Apify discovery executor", () => {
  it("batches hypotheses in one run and hard-caps a live test to two results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "1" }, { id: "2" }, { id: "3" }]), {
        status: 200,
      }),
    );
    const result = await executeApifyBatch({
      providerId: "instagram",
      queries: ["squash belgrade", "squash serbia"],
      token: "test-token-value",
      resultsPerQuery: 10,
      maxItems: 100,
      testMode: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("maxItems=2");
    expect(String(url)).toContain("maxTotalChargeUsd=0.01");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token-value",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      search: "squash belgrade, squash serbia",
      searchType: "user",
      searchLimit: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.queryCount).toBe(2);
    expect(result.maxItems).toBe(2);
  });

  it("builds one provider-specific batch body and estimates costs", () => {
    expect(buildApifyInput("facebook-apify", ["music", "sport"], 10)).toEqual({
      searchQueries: ["music", "sport"],
      startUrls: [],
      maxEvents: 10,
    });
    expect(
      buildApifyInput("google-places", ["squash club", "padel club"], 5),
    ).toMatchObject({
      searchStringsArray: ["squash club", "padel club"],
      maxCrawledPlacesPerSearch: 5,
      maxReviews: 0,
    });
    expect(apifyCost("facebook-apify", 20)).toBe(0.26);
  });

  it("returns a free MCP plan without starting an Actor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await executeApifyTool({
      providerId: "facebook-apify",
      queries: ["music belgrade", "tech meetup belgrade"],
      resultsPerQuery: 5,
      maxItems: 10,
      execute: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "dry-run",
      plan: {
        actor: "apify/facebook-events-scraper",
        maxItems: 10,
        maxChargeUsd: 0.13,
      },
    });
  });

  it("normalizes Instagram discovery as a community and keeps raw data", () => {
    const store = new Store(":memory:");
    try {
      const source = store.saveSource(
        {
          providerId: "instagram",
          name: "Instagram Search · Apify",
          url: "",
          scopeId: "belgrade",
          enabled: true,
          priority: 50,
          keyword: "squash belgrade",
          language: "ru",
          audience: "local",
          categories: ["Спорт"],
        },
        "source-instagram",
      );
      const ctx = {
        source,
        scope: store.scope("belgrade"),
        secrets: { APIFY_TOKEN: "test-token-value" },
      };
      const raw = apifyRawItem("instagram", instagramFixture[0], ctx);
      expect(instagram.normalize(raw, ctx)).toMatchObject({
        type: "Community",
        title: "Caffe Belgrade Squash and Padel Club",
        country: "RS",
        city: "Belgrade",
        externalId: "7447308366",
        memberCount: 1387,
        category: "Общение",
        tags: ["instagram"],
        languages: [],
        audience: "all",
      });
      expect((raw.payload as any).original.followersCount).toBe(1387);
      const outside = apifyRawItem("instagram", instagramFixture[1], ctx);
      expect(instagram.normalize(outside, ctx)).toMatchObject({
        country: "RO",
        city: "",
      });
    } finally {
      store.close();
    }
  });

  it("normalizes the Facebook Events MCP fixture as an event", () => {
    const store = new Store(":memory:");
    try {
      const source = store.saveSource(
        {
          providerId: "facebook-apify",
          name: "Facebook Events · Apify",
          scopeId: "belgrade",
          enabled: true,
        },
        "source-facebook-apify",
      );
      const ctx = {
        source,
        scope: store.scope("belgrade"),
        secrets: { APIFY_TOKEN: "test-token-value" },
      };
      const raw = apifyRawItem("facebook-apify", facebookFixture[0], ctx);
      expect(facebook.normalize(raw, ctx)).toMatchObject({
        type: "Event",
        title: "Belgrade Product Meetup",
        city: "Belgrade",
        startAt: "2026-10-20T17:00:00Z",
        venue: "Impact Hub Belgrade",
        externalId: "fb-event-101",
      });
    } finally {
      store.close();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { SyncService } from "../server/sync";
import {
  googlePlacesFieldMasks,
  searchGooglePlacesText,
} from "../server/providers/google-places/client";
import {
  executeGooglePlacesDiscovery,
  rememberGooglePlaceIds,
} from "../server/providers/google-places/discovery";
import {
  googleBillingMonth,
  googlePlacesQuotaStatus,
} from "../server/providers/google-places/quota";
import {
  googlePlacesEntity,
  googlePlacesRawItem,
} from "../server/providers/google-places/provider";
import {
  applyGooglePlacesLlmRatings,
  persistGooglePlacesResults,
} from "../server/providers/google-places/tool";

afterEach(() => vi.restoreAllMocks());

function context(store: Store) {
  const source = store.source("source-google-places-api");
  return {
    source,
    scope: store.scope(source.scopeId),
    secrets: { GOOGLE_PLACES_API_KEY: "test-google-key-value" },
    store,
  };
}

describe("Google Places API (New)", () => {
  it("uses Pacific billing months and independent local SKU counters", async () => {
    expect(googleBillingMonth(new Date("2026-10-01T06:59:59Z"))).toBe(
      "2026-09",
    );
    expect(googleBillingMonth(new Date("2026-10-01T07:00:00Z"))).toBe(
      "2026-10",
    );
    const store = new Store(":memory:");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ places: [{ id: "place-1" }] }), {
          status: 200,
        }),
      );
      await searchGooglePlacesText(
        {
          query: "squash club",
          location: "Belgrade, Serbia",
          mode: "ids_only",
          minRating: 4,
          pageSize: 10,
          apiKey: "test-google-key-value",
          sourceId: "source-google-places-api",
        },
        store,
      );
      const quota = googlePlacesQuotaStatus(store);
      expect(quota.bySku.ids_only.used).toBe(1);
      expect(quota.bySku.ids_only.limit).toBeNull();
      expect(quota.bySku.pro.used).toBe(0);
      expect(quota.proEquivalentUnits).toBe(0);
    } finally {
      store.close();
    }
  });

  it("sends minRating=4 and an IDs-only field mask without paid fields", async () => {
    const store = new Store(":memory:");
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ places: [{ id: "place-1" }] }), {
          status: 200,
        }),
      );
      await searchGooglePlacesText(
        {
          query: "padel club",
          location: "Belgrade, Serbia",
          mode: "ids_only",
          pageSize: 7,
          apiKey: "test-google-key-value",
        },
        store,
      );
      const [, init] = fetchMock.mock.calls[0];
      expect(
        (init?.headers as Record<string, string>)["X-Goog-FieldMask"],
      ).toBe("places.id,places.name,nextPageToken");
      expect(googlePlacesFieldMasks.ids_only).not.toContain("displayName");
      expect(googlePlacesFieldMasks.pro).toContain("places.googleMapsUri");
      expect(googlePlacesFieldMasks.pro).not.toContain("places.rating");
      expect(googlePlacesFieldMasks.enterprise).toContain("places.rating");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        textQuery: "padel club in Belgrade, Serbia",
        minRating: 4,
        pageSize: 7,
      });
    } finally {
      store.close();
    }
  });

  it("runs Pro only for productive IDs queries and validates name and geo", async () => {
    const store = new Store(":memory:");
    try {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { textQuery: string };
          const mask = (init?.headers as Record<string, string>)[
            "X-Goog-FieldMask"
          ];
          if (mask === googlePlacesFieldMasks.ids_only)
            return new Response(
              JSON.stringify({
                places: body.textQuery.startsWith("squash")
                  ? [{ id: "squash-1", name: "places/squash-1" }]
                  : [],
              }),
              { status: 200 },
            );
          return new Response(
            JSON.stringify({
              places: [
                {
                  id: "squash-1",
                  displayName: { text: "Belgrade Squash Club" },
                  formattedAddress: "Belgrade, Serbia",
                  location: { latitude: 44.8, longitude: 20.4 },
                  googleMapsUri: "https://maps.google.com/?cid=1",
                  types: ["sports_club"],
                },
              ],
            }),
            { status: 200 },
          );
        });
      const result = await executeGooglePlacesDiscovery({
        store,
        apiKey: "test-google-key-value",
        sourceId: "source-google-places-api",
        queries: ["squash club", "nonexistent activity"],
        location: "Belgrade, Serbia",
        minRating: 4,
        resultsPerQuery: 10,
        maxItems: 20,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.productiveQueries).toEqual(["squash club"]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].place.googleMapsUri).toContain(
        "maps.google.com",
      );
      expect(googlePlacesQuotaStatus(store).bySku).toMatchObject({
        ids_only: { used: 2 },
        pro: { used: 1 },
        enterprise: { used: 0 },
      });
      const raw = googlePlacesRawItem(result.results[0].place, context(store));
      expect(
        googlePlacesEntity(result.results[0].place, context(store)),
      ).toMatchObject({
        title: "Belgrade Squash Club",
        latitude: 44.8,
        longitude: 20.4,
        knownIds: { google_place: "squash-1" },
      });
      expect(raw.url).toContain("maps.google.com");
    } finally {
      store.close();
    }
  });

  it("remembers Pro display names and exposes the monthly paid-tier counters", async () => {
    const store = new Store(":memory:");
    try {
      rememberGooglePlaceIds(store, "ethiopian restaurant", [
        {
          id: "named-place-1",
          displayName: { text: "Addis Example" },
        },
      ]);
      rememberGooglePlaceIds(store, "another query", [{ id: "named-place-1" }]);
      expect(
        store.db
          .prepare(
            "SELECT displayName FROM google_places_discovered_ids WHERE placeId=?",
          )
          .get("named-place-1"),
      ).toEqual({ displayName: "Addis Example" });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ places: [] }), { status: 200 }),
      );
      await searchGooglePlacesText(
        {
          query: "quota example",
          location: "Belgrade, Serbia",
          mode: "pro",
          minRating: 4.5,
          pageSize: 1,
          apiKey: "test-google-key-value",
          sourceId: "source-google-places-api",
        },
        store,
      );
      const sourceView = new SyncService(store)
        .views()
        .find((source) => source.providerId === "google-places-api");
      expect(sourceView?.quotaUsage).toMatchObject({
        sku: "pro",
        used: 1,
        limit: 5000,
        remaining: 4999,
      });
      expect(sourceView?.enterpriseQuotaUsage).toMatchObject({
        sku: "enterprise",
        used: 0,
        limit: 1000,
        remaining: 1000,
      });
    } finally {
      store.close();
    }
  });

  it("stores Place cards while keeping ratings as separate LLM enrichment", () => {
    const store = new Store(":memory:");
    try {
      const place = {
        id: "place-local-1",
        displayName: { text: "Local Padel Club" },
        formattedAddress: "Belgrade, Serbia",
        location: { latitude: 44.81, longitude: 20.46 },
        googleMapsUri: "https://maps.google.com/?cid=local-1",
        types: ["sports_club"],
        rating: 4.9,
        userRatingCount: 321,
      };
      expect(
        persistGooglePlacesResults(store, "source-google-places-api", [
          { place, matchedQueries: ["padel belgrade"] },
        ]),
      ).toMatchObject({ created: 1 });
      let stored = store
        .entities()
        .find((entity) => entity.title === "Local Padel Club")!;
      expect(stored).toMatchObject({
        url: "https://maps.google.com/?cid=local-1",
        googleRating: null,
        googleReviewCount: null,
        knownIds: { google_place: "place-local-1" },
      });
      const raw = store.db
        .prepare("SELECT rawPayload FROM source_items WHERE externalId=?")
        .get("place-local-1") as { rawPayload: string };
      expect(raw.rawPayload).not.toContain('"rating"');
      expect(raw.rawPayload).not.toContain('"userRatingCount"');

      expect(
        applyGooglePlacesLlmRatings(store, {
          items: [
            {
              placeId: "place-local-1",
              rating: 4.8,
              reviewCount: 300,
              source: "LLM web research · Google Maps page",
              checkedAt: "2026-10-01T12:00:00.000Z",
            },
          ],
        }),
      ).toMatchObject({ ok: true, apiRequests: 0 });
      stored = store.entity(stored.id);
      expect(stored).toMatchObject({
        googleRating: 4.8,
        googleReviewCount: 300,
        googleRatingSource: "LLM web research · Google Maps page",
        googleRatingCheckedAt: "2026-10-01T12:00:00.000Z",
      });

      persistGooglePlacesResults(store, "source-google-places-api", [
        {
          place: { ...place, displayName: { text: "Local Padel Club" } },
          matchedQueries: ["social sports belgrade"],
        },
      ]);
      expect(store.entity(stored.id)).toMatchObject({
        googleRating: 4.8,
        googleReviewCount: 300,
      });

      persistGooglePlacesResults(
        store,
        "source-google-places-api",
        [
          {
            place: { ...place, displayName: { text: "Local Padel Club" } },
            matchedQueries: ["enterprise padel belgrade"],
          },
        ],
        {
          enterpriseRatingSource: "Google Places API · Text Search Enterprise",
        },
      );
      expect(store.entity(stored.id)).toMatchObject({
        googleRating: 4.9,
        googleReviewCount: 321,
        googleRatingSource: "Google Places API · Text Search Enterprise",
      });
    } finally {
      store.close();
    }
  });
});

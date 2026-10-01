import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import quotas from "../data/provider-quotas.json";
import {
  foursquareApiVersion,
  searchFoursquarePlaces,
} from "../server/providers/foursquare/client";
import { foursquareEntity } from "../server/providers/foursquare/provider";
import { executeFoursquareTool } from "../server/providers/foursquare/tool";
import {
  foursquareQuotaStatus,
  reserveFoursquareRequest,
} from "../server/providers/foursquare/quota";
import { apifyConfigs } from "../server/providers/apify/client";
import { Store } from "../server/store";
import fixture from "./fixtures/foursquare-place-search.json";

let temporaryDirectory = "";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporaryDirectory)
    rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

function isolatedQuota() {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "activity-fsq-test-"));
  const path = join(temporaryDirectory, "quota.json");
  vi.stubEnv("FOURSQUARE_QUOTA_FILE", path);
  return path;
}

describe("Foursquare MCP", () => {
  it("keeps provider prices and the 500-request hard limit in the quota file", () => {
    expect(quotas.apify.instagram.pricePerResultUsd).toBe(
      apifyConfigs.instagram.pricePerResult,
    );
    expect(quotas.apify.facebookEvents.pricePerResultUsd).toBe(
      apifyConfigs["facebook-apify"].pricePerResult,
    );
    expect(quotas.apify.googleMaps.pricePerResultUsd).toBe(
      apifyConfigs["google-places"].pricePerResult,
    );
    expect(quotas.foursquare.freeRequests).toBe(500);
    expect(quotas.foursquare.localHardLimit).toBe(500);
    expect(quotas.foursquare.apiVersion).toBe(foursquareApiVersion);
  });

  it("uses the current Places API headers and increments quota once", async () => {
    const quotaPath = isolatedQuota();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const result = await searchFoursquarePlaces({
      query: "squash club",
      near: "Belgrade, Serbia",
      limit: 5,
      apiKey: "test-service-key-value",
    });
    expect(result.places).toHaveLength(1);
    expect(result.quota).toMatchObject({ used: 1, remaining: 499 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("places-api.foursquare.com/places/search");
    expect(String(url)).toContain("query=squash+club");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-service-key-value",
      "X-Places-Api-Version": "2025-06-17",
    });
    expect(JSON.parse(readFileSync(quotaPath, "utf8"))).toMatchObject({
      used: 1,
    });
  });

  it("plans without spending quota and normalizes a place", async () => {
    isolatedQuota();
    const plan = await executeFoursquareTool({
      queries: ["squash", "padel"],
      execute: false,
    });
    expect(plan).toMatchObject({
      mode: "dry-run",
      plan: { requestCount: 2 },
    });
    expect(foursquareQuotaStatus()).toMatchObject({ used: 0, remaining: 500 });

    const store = new Store(":memory:");
    try {
      const original = store.source("source-foursquare");
      const source = store.saveSource(
        {
          providerId: original.providerId,
          name: original.name,
          enabled: original.enabled,
          language: "ru",
          audience: "local",
          categories: ["Музыка"],
        },
        original.id,
      );
      expect(
        foursquareEntity(fixture.results[0], {
          source,
          scope: store.scope("belgrade"),
          secrets: {},
        }),
      ).toMatchObject({
        type: "Place",
        title: "Belgrade Squash Club",
        city: "Belgrade",
        country: "RS",
        category: "Спорт",
        languages: [],
        audience: "all",
        memberCount: null,
        knownIds: { foursquare: "fsq-test-squash-1" },
      });
    } finally {
      store.close();
    }
  });

  it("fails closed when the local quota counter is corrupt", () => {
    const quotaPath = isolatedQuota();
    writeFileSync(quotaPath, "not-json", { mode: 0o600 });
    expect(() => foursquareQuotaStatus()).toThrow(
      "Не удалось прочитать локальный счётчик квоты Foursquare",
    );
  });

  it("does not delete a lock owned by another process", () => {
    const quotaPath = isolatedQuota();
    const lockPath = `${quotaPath}.lock`;
    writeFileSync(lockPath, "occupied", { mode: 0o600 });
    expect(() => reserveFoursquareRequest()).toThrow(
      "Другой Foursquare-запрос обновляет счётчик квоты",
    );
    expect(existsSync(lockPath)).toBe(true);
  });
});

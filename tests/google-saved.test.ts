import { entitySchema } from "../shared/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store";
import {
  DailyLedger,
  quotaDay,
  reserveMcpRequest,
  withMcpBudget,
} from "../server/providers/google-places/mcp-budget";
import {
  parseSavedArchive,
  importSavedItems,
  knownGooglePlace,
  mapsIdentity,
} from "../server/google-saved";
import { executeGooglePlacesDiscovery } from "../server/providers/google-places/discovery";
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GOOGLE_PLACES_MCP_QUOTA_DB;
});
function ledgerFile() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "places-quota-"));
  process.env.GOOGLE_PLACES_MCP_QUOTA_DB = join(dir, "quota.sqlite");
  return () => rmSync(dir, { recursive: true, force: true });
}
describe("MCP daily quota", () => {
  it("counts only Belgrade today and caps reservations at 100 across connections", () => {
    const cleanup = ledgerFile(),
      a = new DailyLedger(),
      b = new DailyLedger();
    try {
      const day = new Date("2026-10-05T12:00:00Z");
      for (let i = 0; i < 100; i++) (i % 2 ? a : b).reserve(day);
      expect(a.status(day).remaining).toBe(0);
      expect(() => b.reserve(day)).toThrow();
      expect(b.status(new Date("2026-10-06T00:00:00Z")).used).toBe(0);
      expect(quotaDay(new Date("2026-10-05T22:00:00Z"))).toBe("2026-10-06");
    } finally {
      a.close();
      b.close();
      cleanup();
    }
  });
  it("requires a run budget, clamps to remaining and blocks Enterprise", async () => {
    const cleanup = ledgerFile();
    try {
      const ledger = new DailyLedger();
      for (let i = 0; i < 98; i++) ledger.reserve();
      ledger.close();
      await expect(
        withMcpBudget(true, undefined, async () => ({})),
      ).rejects.toThrow("maxRequests");
      const result = await withMcpBudget(true, 10, async () => {
        expect(() => reserveMcpRequest("enterprise")).toThrow();
        reserveMcpRequest("ids_only");
        reserveMcpRequest("pro");
        expect(() => reserveMcpRequest("pro")).toThrow();
        return {};
      });
      expect(result.budget).toMatchObject({ allowed: 2, used: 2 });
      expect(result.dailyQuota.remaining).toBe(0);
    } finally {
      cleanup();
    }
  });
  it("stops a two-pass discovery within the per-run budget without issuing extra HTTP", async () => {
    const cleanup = ledgerFile(),
      store = new Store(":memory:");
    try {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ places: [{ id: "fresh" }] })),
        );
      const result = await withMcpBudget(true, 1, () =>
        executeGooglePlacesDiscovery({
          store,
          apiKey: "test-google-api-key",
          sourceId: "source-google-places-api",
          queries: ["restaurants"],
          location: "Belgrade",
          minRating: 4,
          resultsPerQuery: 10,
          maxItems: 10,
        }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.proPass).toHaveLength(0);
      expect(result.budget.used).toBe(1);
    } finally {
      store.close();
      cleanup();
    }
  });
});
it("excludes only restaurant cards, including edited names and Maps IDs; ignores other Places",()=>{
  const store=new Store(":memory:");
  try {
    for(const [id,tags,url] of [["restaurant",["restaurant"],"https://maps.google.com/?cid=777"],["park",["park"],"https://maps.google.com/?cid=888"]] as const){
      const entity=entitySchema.parse({type:"Place",title:id,tags:[...tags],url,knownIds:{google_place:id}});
      store.ingest(store.source("source-manual"),[{entity,raw:{externalId:id,url,rawText:"",payload:entity}}]);
    }
    expect(knownGooglePlace(store,{id:"restaurant"})).toBe(true);
    expect(knownGooglePlace(store,{id:"new",googleMapsUri:"https://www.google.com/maps/?cid=777"})).toBe(true);
    expect(knownGooglePlace(store,{id:"new",displayName:{text:"RESTAURANT"}})).toBe(true);
    expect(knownGooglePlace(store,{id:"park",displayName:{text:"park"},googleMapsUri:"https://maps.google.com/?cid=888"})).toBe(false);
  } finally {store.close();}
});
describe("saved exports", () => {
  it("parses descriptions, quoted multiline notes, tags and persists idempotently while Takeout novelty checks are paused", async () => {
    const items = await parseSavedArchive(
      Buffer.from(
        'My favourite places\n\ntitle,note,item_content_url,tags,comment\n"Cafe, One","Line 1\nLine 2",https://www.google.com/maps/?q=place_id:known,food;coffee,nice\n',
      ),
      "Favourites.csv",
    );
    expect(items[0]).toMatchObject({
      collection: "Favourites",
      description: "My favourite places",
      title: "Cafe, One",
      note: "Line 1\nLine 2",
      tags: ["food", "coffee"],
    });
    const store = new Store(":memory:");
    try {
      importSavedItems(store, items, "manual");
      importSavedItems(store, items, "manual");
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM google_saved_items").get()
          ?.n,
      ).toBe(1);
      expect(knownGooglePlace(store, { id: "known" })).toBe(false);
      expect(
        knownGooglePlace(store, {
          id: "new",
          displayName: { text: "cafe one" },
        }),
      ).toBe(false);
      expect(
        knownGooglePlace(store, {
          id: "new",
          displayName: { text: "Another cafe" },
        }),
      ).toBe(false);
    } finally {
      store.close();
    }
  });
  it("parses ZIP without extracting and rejects path traversal", async () => {
    const items = await parseSavedArchive(
      Buffer.from(
        "UEsDBBQAAAAIAAyNRV2eFcfGQQAAAD8AAAAdAAAAVGFrZW91dC9TYXZlZC9SZXN0YXVyYW50cy5jc3YrySzJSdUpLcrRycsvSeVyTkxL1ckoKSkottLXLy8v10vPz0/PSdVLzs/Vz00sKNa3T85MsTU1NdXJzssvz+MCAFBLAwQUAAAACAAMjUVdTkHU1gkAAAAHAAAAGQAAAFRha2VvdXQvU2F2ZWQvcGljdHVyZS5qcGfLTM/LL0pNAQBQSwECFAMUAAAACAAMjUVdnhXHxkEAAAA/AAAAHQAAAAAAAAAAAAAAgAEAAAAAVGFrZW91dC9TYXZlZC9SZXN0YXVyYW50cy5jc3ZQSwECFAMUAAAACAAMjUVdTkHU1gkAAAAHAAAAGQAAAAAAAAAAAAAAgAF8AAAAVGFrZW91dC9TYXZlZC9waWN0dXJlLmpwZ1BLBQYAAAAAAgACAJIAAAC8AAAAAAA=",
        "base64",
      ),
      "Saved.zip",
    );
    expect(items).toHaveLength(1);
    expect(items[0].collection).toBe("Restaurants");
    await expect(
      parseSavedArchive(
        Buffer.from(
          "UEsDBBQAAAAIAAyNRV243YLUJQAAACMAAAASAAAALi4vUmVzdGF1cmFudHMuY3N2K8ksyUnVKS3K4XJOTEvVySgpKSi20tdPrUjMLchJ1UvOz+UCAFBLAQIUAxQAAAAIAAyNRV243YLUJQAAACMAAAASAAAAAAAAAAAAAACAAQAAAAAuLi9SZXN0YXVyYW50cy5jc3ZQSwUGAAAAAAEAAQBAAAAAVQAAAAAA",
          "base64",
        ),
        "bad.zip",
      ),
    ).rejects.toThrow();
  });
  it("recognizes CID, ignores non-Maps place IDs and parses Maps GeoJSON", async () => {
    expect(
      mapsIdentity("https://www.google.com/maps/place/x/data=!1s0x123:0xff")
        .cid,
    ).toBe("255");
    expect(mapsIdentity("https://example.com/?place_id=known").placeId).toBe(
      "",
    );
    expect(mapsIdentity("https://maps.google.com/?cid=255").cid).toBe("255");
    const items = await parseSavedArchive(
      Buffer.from(
        JSON.stringify({
          features: [
            {
              geometry: { type: "Point", coordinates: [20, 44] },
              properties: {
                "Google Maps URL": "https://www.google.com/maps/?cid=255",
                Location: { "Business Name": "Cafe", Address: "Street" },
              },
            },
          ],
        }),
      ),
      "Starred.json",
    );
    expect(items[0]).toMatchObject({
      title: "Cafe",
      address: "Street",
      latitude: 44,
      longitude: 20,
    });
  });
  it("does not import unrelated JSON or malformed CSV", async () => {
    await expect(
      parseSavedArchive(Buffer.from("{}"), "unrelated.json"),
    ).rejects.toThrow();
    await expect(
      parseSavedArchive(Buffer.from("title,url\na,b,c"), "x.csv"),
    ).rejects.toThrow();
  });
});

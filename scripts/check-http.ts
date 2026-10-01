import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";
const dir = mkdtempSync(join(tmpdir(), "activity-checker-http-"));
const store = new Store(join(dir, "test.sqlite"));
const port = 14318;
const app = createApi(store, port);
const server = app.listen(port, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", () => resolve());
  server.once("error", reject);
});
async function req(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, data: (await r.json()) as any };
}
try {
  assert.equal((await req("/health")).data.ok, true);
  const crossSiteNavigation = await fetch(`http://127.0.0.1:${port}/`, {
    headers: {
      Origin: "http://life-hub.localhost",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    },
  });
  // createApi has no SPA handler in this isolated smoke server; reaching its
  // normal 404 proves the security middleware did not reject navigation.
  assert.equal(crossSiteNavigation.status, 404);
  const initial = await req("/bootstrap");
  assert.equal(initial.data.entities.length, 0);
  assert.ok(initial.data.sources.length >= 15);
  assert.equal(
    initial.data.filterRules.rules.telegramMinMembers.minMembers,
    200,
  );
  assert.equal(initial.data.profile.artists.length, 46);
  assert.ok(initial.data.profile.eventPreferences.length > 0);
  assert.ok(
    initial.data.sources.some(
      (source: any) => source.providerId === "allevents",
    ),
  );
  assert.equal(JSON.stringify(initial.data).includes("API_HASH="), false);
  const { updatedAt: _updatedAt, ...profileInput } = initial.data.profile;
  profileInput.summary = "HTTP profile update";
  const profileUpdate = await req("/profile", "PUT", profileInput);
  assert.equal(profileUpdate.status, 200);
  assert.equal(profileUpdate.data.summary, "HTTP profile update");
  assert.equal((await req("/profile")).data.summary, "HTTP profile update");
  const ruleUpdate = await req("/filter-rules", "PUT", {
    ...initial.data.filterRules.rules,
    telegramMinMembers: { enabled: true, minMembers: 300 },
  });
  assert.equal(ruleUpdate.status, 200);
  assert.equal(
    (await req("/filter-rules")).data.rules.telegramMinMembers.minMembers,
    300,
  );
  await req("/import", "POST", {
    entities: [
      { type: "Event", title: "Past HTTP event", startAt: "2000-01-01" },
    ],
  });
  const pastArchive = await req("/entities/archive-past", "POST", {
    scopeId: "belgrade",
  });
  assert.equal(pastArchive.data.archived, 1);
  assert.equal((await req("/bootstrap")).data.entities.length, 0);
  const batch = {
    entities: [
      {
        type: "Community",
        title: "HTTP test",
        url: "https://example.test/club",
        description: "See https://t.me/example_club",
      },
    ],
  };
  assert.equal(
    (await req("/import/preview", "POST", batch)).data.result.created,
    1,
  );
  assert.equal((await req("/bootstrap")).data.entities.length, 0);
  assert.equal((await req("/import", "POST", batch)).data.result.created, 1);
  assert.equal((await req("/import", "POST", batch)).data.result.duplicates, 1);
  const state = await req("/bootstrap");
  const id = state.data.entities[0].id;
  assert.equal(state.data.candidates.length, 1);
  await req("/entities/" + id, "PATCH", { favorite: true, notes: "HTTP note" });
  assert.equal((await req("/entities/" + id)).data.favorite, true);
  assert.equal((await req("/entities/" + id)).data.provenance.length, 1);
  assert.equal(
    (
      await req("/import", "POST", {
        entities: [{ type: "Wrong", title: "No" }],
      })
    ).status,
    400,
  );
  assert.equal((await req("/bootstrap")).data.entities.length, 1);
  assert.equal(
    (await req("/sources/source-allevents/sync", "POST", {})).status,
    400,
  );
  const schema = await req("/import/schema");
  assert.equal(schema.status, 200);
  assert.ok(schema.data.properties.entities);
  assert.ok(schema.data.properties.entities.items.properties.cuisine);
  const exported = await req("/export");
  assert.equal(exported.data.entities.length, 1);
  assert.equal(
    (await req("/import/preview", "POST", exported.data)).status,
    200,
  );
  const denied = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: "POST",
    headers: {
      Origin: "https://untrusted.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(batch),
  });
  assert.equal(denied.status, 403);
  const wrongType = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const invalidHost = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/health",
          headers: { Host: "untrusted.test" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
    },
  );
  assert.equal(invalidHost, 403);
  console.log(
    "HTTP smoke: Life Hub navigation, profile, past-event archive, preview, import, dedup, provenance, edits, catalog, schema, export, validation, Host/Origin checks — OK.",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

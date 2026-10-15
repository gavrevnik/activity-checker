// Keep raw source results on disk and pass only eligible candidates to relevance analysis.
import { readFile, writeFile } from "node:fs/promises";
const [
  input,
  output,
  scopeId = "belgrade",
  apiBase = "http://127.0.0.1:4318/api",
] = process.argv.slice(2);
if (!input || !output || input === output)
  throw Error(
    "Usage: node --import tsx scripts/filter-recommendation-candidates.ts <input.json> <output.json> [scopeId] [apiBase]",
  );
const candidates: unknown = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(candidates))
  throw Error("Input must be a JSON array of candidates");
const endpoint = new URL(
  apiBase.replace(/\/$/, "") + "/recommendations/filter-candidates",
);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.protocol !== "http:" ||
  endpoint.username ||
  endpoint.password
)
  throw Error("Use the local loopback Activity Checker API");
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ scopeId, candidates }),
  signal: AbortSignal.timeout(15000),
});
const result = await response.json();
if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
await writeFile(output, JSON.stringify(result.candidates, null, 2) + "\n", {
  flag: "wx",
});
console.log(
  JSON.stringify({
    output,
    eligible: result.candidates.length,
    excludedCount: result.excludedCount,
  }),
);

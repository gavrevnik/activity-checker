import { createHash } from "node:crypto";
import { entitySchema, type NormalizedEntity } from "../shared/model.js";
export const digest = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + stable(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
export const nameKey = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function canonicalUrl(value: string) {
  if (!value) return "";
  try {
    const u = new URL(value);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()])
      if (/^(utm_.*|fbclid|gclid|mc_cid|mc_eid)$/i.test(key))
        u.searchParams.delete(key);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.href;
  } catch {
    return "";
  }
}
export function normalize(value: unknown): NormalizedEntity {
  const e = entitySchema.parse(value);
  const city = ["belgrade", "beograd", "београд", "белград"].includes(
    e.city.toLowerCase(),
  )
    ? "Belgrade"
    : e.city;
  return {
    ...e,
    city,
    startAt: e.startAt.includes("T")
      ? new Date(e.startAt).toISOString()
      : e.startAt,
    endAt: e.endAt.includes("T") ? new Date(e.endAt).toISOString() : e.endAt,
    tags: [...new Set(e.tags.filter(Boolean))],
    languages: [...new Set(e.languages.map((l) => l.toLowerCase()))],
  };
}
export function identityKeys(e: NormalizedEntity): string[] {
  const prefix = [e.demo ? "demo" : "real", e.type, e.country].join(":") + ":";
  const keys: string[] = [];
  for (const [k, v] of Object.entries(e.knownIds)) keys.push(`id:${k}:${v}`);
  const url = canonicalUrl(e.url);
  const specific = url && new URL(url).pathname !== "/";
  if (
    url &&
    (e.type !== "Event" || (specific && e.startAt)) &&
    (e.type !== "Place" || specific)
  )
    keys.push(`url:${url}${e.type === "Event" ? ":" + e.startAt : ""}`);
  if (e.type === "Event" && e.startAt && e.venue)
    keys.push(
      `event:${nameKey(e.title)}:${e.startAt}:${nameKey(e.venue)}:${nameKey(e.city)}`,
    );
  if (e.type === "Place") {
    if (e.address)
      keys.push(
        `place:${nameKey(e.title)}:${nameKey(e.address)}:${nameKey(e.city)}`,
      );
    if (e.latitude != null && e.longitude != null)
      keys.push(
        `geo:${nameKey(e.title)}:${e.latitude.toFixed(4)},${e.longitude.toFixed(4)}`,
      );
  }
  if (
    (e.type === "Community" || e.type === "Organizer") &&
    (e.url || e.website)
  )
    keys.push(`social:${nameKey(e.title)}:${canonicalUrl(e.url || e.website)}`);
  return [...new Set(keys)].map((k) => prefix + k);
}

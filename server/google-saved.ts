import { entitySchema } from "../shared/model.js";
import { buildEntityPresentation } from "./entity-presentation.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Store } from "./store.js";
import type { GooglePlace } from "./providers/google-places/client.js";

const itemSchema = z
  .object({
    collection: z.string().max(500),
    description: z.string().max(10000),
    title: z.string().max(1000),
    note: z.string().max(10000),
    url: z.string().max(10000),
    tags: z.array(z.string().max(1000)).max(100),
    comment: z.string().max(10000),
    address: z.string().max(2000).default(""),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
  })
  .strict();
export type SavedItem = z.output<typeof itemSchema>;
export function mapsIdentity(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { placeId: "", cid: "", url: "" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { placeId: "", cid: "", url: "" };
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const maps =
    /(^|\.)(google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$/i.test(url.hostname) &&
    (url.hostname.startsWith("maps.google.") ||
      url.pathname.includes("/maps") ||
      /^(maps\.app\.goo\.gl|goo\.gl)$/.test(url.hostname));
  const id = maps
    ? url.searchParams.get("query_place_id") ||
      url.searchParams.get("place_id") ||
      decoded.match(/place_id:([A-Za-z0-9_-]+)/)?.[1] ||
      ""
    : "";
  const hex = maps
    ? decoded.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i)?.[1]
    : undefined;
  const cid = maps
    ? url.searchParams.get("cid") || (hex ? BigInt("0x" + hex).toString() : "")
    : "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith("utm_") || key === "hl") url.searchParams.delete(key);
  url.searchParams.sort();
  return { placeId: id, cid, url: url.toString() };
}
export async function parseSavedArchive(
  bytes: Buffer,
  filename: string,
): Promise<SavedItem[]> {
  if (!bytes.length || bytes.length > 50 * 1024 * 1024)
    throw new Error("Файл должен быть от 1 байта до 50 МБ.");
  const format = filename.toLowerCase().endsWith(".zip")
    ? "zip"
    : filename.toLowerCase().endsWith(".csv")
      ? "csv"
      : filename.toLowerCase().endsWith(".json")
        ? "json"
        : "";
  if (!format) throw new Error("Поддерживаются ZIP, CSV и Maps GeoJSON.");
  const script = fileURLToPath(
    new URL("../scripts/google-saved-archive.py", import.meta.url),
  );
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-B", script, format, filename.slice(0, 500)],
      { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Парсер превысил лимит времени."));
    }, 30000);
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 20 * 1024 * 1024) {
        child.kill();
        reject(new Error("Слишком много данных в выгрузке."));
      } else chunks.push(b);
    });
    child.stderr.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(
            new Error(
              "Выгрузка не распознана или превышает ограничения парсера.",
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
  return z.array(itemSchema).max(20000).parse(JSON.parse(output));
}
export function importSavedItems(
  store: Store,
  input: SavedItem[],
  kind: string,
) {
  const items = z.array(itemSchema).min(1).max(20000).parse(input);
  const id = randomUUID(),
    collections = new Set(items.map((i) => i.collection)).size;
  store.transaction(() => {
    store.db
      .prepare("INSERT INTO google_saved_imports VALUES (?,?,?,?,?)")
      .run(id, new Date().toISOString(), kind, items.length, collections);
    const insert = store.db.prepare(
      "INSERT INTO google_saved_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET importId=excluded.importId,title=excluded.title,url=excluded.url,placeId=excluded.placeId,cid=excluded.cid,description=excluded.description,note=excluded.note,tags=excluded.tags,comment=excluded.comment,address=excluded.address,latitude=excluded.latitude,longitude=excluded.longitude",
    );
    for (const item of items) {
      const identity = mapsIdentity(item.url);
      const itemId = createHash("sha256")
        .update(
          JSON.stringify([
            item.collection,
            identity.placeId || identity.cid || identity.url || item.title,
          ]),
        )
        .digest("hex");
      insert.run(
        itemId,
        id,
        item.collection,
        item.description,
        item.title,
        item.note,
        identity.url,
        JSON.stringify(item.tags),
        item.comment,
        identity.placeId,
        identity.cid,
        item.address,
        item.latitude,
        item.longitude,
      );
    }
  });
  return { id, items: items.length, collections };
}
export function savedListsStatus(store: Store) {
  const exists = store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='google_saved_items'")
    .get();
  if (!exists)
    return { available: false, items: 0, collections: [], imports: [] };
  const collections = store.db
    .prepare(
      "SELECT collection,COUNT(*) AS items FROM google_saved_items GROUP BY collection ORDER BY collection",
    )
    .all();
  const imports = store.db
    .prepare(
      "SELECT * FROM google_saved_imports ORDER BY importedAt DESC LIMIT 10",
    )
    .all();
  return {
    available: true,
    items: (
      store.db
        .prepare("SELECT COUNT(*) AS n FROM google_saved_items")
        .get() as { n: number }
    ).n,
    collections,
    imports,
  };
}
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function knownGooglePlace(store: Store, place: GooglePlace) {
  // Only existing restaurant cards define familiarity. Takeout and discovery receipts are paused.
  const suffix = `:id:google_place:${place.id}`;
  const ids = new Set(store.db.prepare("SELECT entityId FROM entity_keys WHERE substr(key,-length(?))=?").all(suffix,suffix).map(row => String(row.entityId)));
  const identity = mapsIdentity(place.googleMapsUri || "");
  const title = norm(place.displayName?.text || "");
  const rows = store.db.prepare("SELECT id,data FROM entities WHERE type='Place'").all();
  for (const row of rows) {
    const data = entitySchema.parse(JSON.parse(String(row.data)));
    if (!buildEntityPresentation(data).isRestaurant) continue;
    if (ids.has(String(row.id)) || data.knownIds.google_place === place.id) return true;
    if (sameIdentity(mapsIdentity(data.url),identity,place.id)) return true;
    if (title && norm(data.title) === title) return true;
  }
  return false;
}

function sameIdentity(
  a: ReturnType<typeof mapsIdentity>,
  b: ReturnType<typeof mapsIdentity>,
  id: string,
) {
  return Boolean(
    (a.placeId && (a.placeId === id || a.placeId === b.placeId)) ||
    (a.cid && a.cid === b.cid) ||
    (a.url && b.url && a.url === b.url),
  );
}

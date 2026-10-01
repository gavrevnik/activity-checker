import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSecrets, safeError } from "../server/secrets.js";
import { Store } from "../server/store.js";
import {
  apifyRawItem,
  isApifyProviderId,
} from "../server/providers/apify/providers.js";
import { getProvider } from "../server/providers/registry.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentsFor(name: string) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifier(item: unknown) {
  const outer = record(item);
  const data = Object.keys(record(outer.user)).length
    ? record(outer.user)
    : outer;
  for (const key of ["username", "id", "eventId", "placeId"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim())
      return value.trim().toLowerCase();
    if (typeof value === "number") return String(value);
  }
  return "";
}

async function main() {
  const inputPath = argument("--input");
  const providerId = argument("--provider");
  const requested = [
    ...new Set(argumentsFor("--id").map((value) => value.toLowerCase())),
  ];
  if (!inputPath) throw new Error("Укажите --input с сохранённым dataset.");
  if (!providerId || !isApifyProviderId(providerId))
    throw new Error("Укажите поддерживаемый --provider.");
  if (!requested.length)
    throw new Error(
      "Укажите хотя бы один --id: импорт всего dataset без отбора запрещён.",
    );

  const payload = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as {
    items?: unknown[];
  };
  if (!Array.isArray(payload.items))
    throw new Error("В файле отсутствует массив items.");
  const requestedSet = new Set(requested);
  const selected = payload.items.filter((item) =>
    requestedSet.has(identifier(item)),
  );
  const found = new Set(selected.map(identifier));
  const missing = requested.filter((id) => !found.has(id));

  const secrets = readSecrets();
  const store = new Store(
    process.env.ACTIVITY_DB ||
      secrets.ACTIVITY_DB ||
      "../data/activity-checker/activity.sqlite",
  );
  try {
    const source = store.source(argument("--source") || `source-${providerId}`);
    if (source.providerId !== providerId)
      throw new Error("Источник не соответствует выбранному провайдеру.");
    const provider = getProvider(providerId);
    const ctx = {
      source,
      scope: store.scope(source.scopeId),
      secrets,
    };
    const records = selected.flatMap((item) => {
      const raw = apifyRawItem(providerId, item, ctx);
      const entity = provider.normalize(raw, ctx);
      return entity ? [{ raw, entity }] : [];
    });
    const result = store.ingest(source, records);
    console.log(
      JSON.stringify(
        {
          provider: providerId,
          requested: requested.length,
          selected: selected.length,
          missing,
          result,
          identifiers: selected.map(identifier),
        },
        null,
        2,
      ),
    );
  } finally {
    store.db.close();
  }
}

await main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

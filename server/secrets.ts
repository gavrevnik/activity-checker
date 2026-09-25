import { readFileSync } from "node:fs";
import { parse } from "dotenv";
const keys = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TGSTAT_TOKEN",
  "APIFY_TOKEN",
  "SCRAPECREATORS_API_KEY",
  "TICKETMASTER_API_KEY",
  "MEETUP_ACCESS_TOKEN",
  "EVENTBRITE_TOKEN",
  "PREDICTHQ_TOKEN",
  "GOOGLE_PLACES_API_KEY",
  "FOURSQUARE_API_KEY",
  "OVERPASS_URL",
];
export function readSecrets(): Record<string, string | undefined> {
  let file: Record<string, string> = {};
  try {
    file = parse(readFileSync(".env.local"));
  } catch {}
  return Object.fromEntries(
    keys.map((k) => [k, process.env[k] || file[k] || undefined]),
  );
}
export function safeError(err: unknown): string {
  let message = err instanceof Error ? err.message : "Неизвестная ошибка";
  for (const value of Object.values(readSecrets()))
    if (value && value.length > 3)
      message = message.split(value).join("[скрыто]");
  return message
    .replace(/([?&](?:key|apikey|token|access_token)=)[^&\s]+/gi, "$1[скрыто]")
    .slice(0, 800);
}

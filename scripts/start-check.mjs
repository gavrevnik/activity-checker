// Deliberately runs before npm install: local checks and loopback health only.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let file = {};
try {
  file = parseEnv(readFileSync(resolve(root, ".env.local"), "utf8"));
} catch {}
const setting = (key) => process.env[key] || file[key] || "";
const present = (key) => Boolean(setting(key).trim());
const nodeReady = Number(process.versions.node.split(".")[0]) >= 24;
const dbPath = resolve(
  root,
  setting("ACTIVITY_DB") || "../data/activity-checker/activity.sqlite",
);
let database = { status: "missing" };
if (existsSync(dbPath) && nodeReady) {
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const applied = new Set(
      db
        .prepare("SELECT name FROM migrations")
        .all()
        .map((r) => r.name),
    );
    const pending = readdirSync(resolve(root, "migrations")).filter(
      (name) => name.endsWith(".sql") && !applied.has(name),
    );
    database = {
      status: pending.length ? "migration-needed" : "ready",
      pendingMigrations: pending.length,
    };
  } catch {
    database = { status: "unreadable-or-uninitialized" };
  } finally {
    db?.close();
  }
}
const port = Number(setting("PORT") || 4318);
let web = "not-running";
if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    const health = await response.json();
    web =
      response.ok && (health.app || health.application) === "activity-checker"
        ? "verified"
        : "different-service";
  } catch {}
} else web = "invalid-port";
const session = resolve(
  root,
  setting("TELEGRAM_SESSION_PATH") ||
    "../data/activity-checker/telegram/activity-checker",
);
const python = resolve(
  root,
  setting("TELEGRAM_PYTHON") ||
    (process.platform === "win32"
      ? ".venv-telegram/Scripts/python.exe"
      : ".venv-telegram/bin/python"),
);
const credentials = {
  Telegram: ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"],
  Apify: ["APIFY_TOKEN"],
  Ticketmaster: ["TICKETMASTER_API_KEY"],
};
const services = Object.entries(credentials).map(([name, keys]) => ({
  name,
  required: name === "Telegram" ? "for-telegram-coverage" : "optional",
  status: keys.every(present) ? "configured-unverified" : "missing-keys",
  missing: keys.filter((key) => !present(key)),
  ...(name === "Telegram"
    ? {
        python: existsSync(python),
        session: existsSync(
          session.endsWith(".session") ? session : session + ".session",
        ),
      }
    : {}),
}));
const installed = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  return !r.error && r.status === 0;
};
let browser = { installed: false, setup: "npm run browser:setup" };
try {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  browser.installed = existsSync(chromium.executablePath());
} catch {}
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      node: nodeReady ? "ready" : "requires-24-or-newer",
      npm: installed(process.platform === "win32" ? "npm.cmd" : "npm", [
        "--version",
      ]),
      uv: installed("uv", ["--version"]),
      connectors: existsSync(
        resolve(root, "../personal-radar/connectors/bootstrap-ts.mjs"),
      ),
      knowledge: existsSync(
        resolve(root, "../personal-radar/knowledge/indexes/manifest.json"),
      ),
      dependencies: existsSync(resolve(root, "node_modules/tsx/package.json")),
      skills: existsSync(resolve(root, ".agents/skills/start/SKILL.md")),
      database,
      web,
      services,
      browser,
      localTools:
        "После установки проверить: npm run start:verify; глобальная регистрация MCP не нужна.",
      publicWeb: "no-provider-key-required; source-availability-not-tested",
      otherProviders:
        "Google Places and Foursquare are not required for recommendation setup",
    },
    null,
    2,
  ),
);

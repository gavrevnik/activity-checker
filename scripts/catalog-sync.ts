import { parse } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const python =
  process.env.CATALOG_SYNC_PYTHON ||
  fileURLToPath(
    new URL("../../personal-radar/.venv/bin/python", import.meta.url),
  );
const script = fileURLToPath(
  new URL("../../personal-radar/scripts/catalog_sync.py", import.meta.url),
);
const root = fileURLToPath(new URL("../", import.meta.url));
let configuredDatabase: string | undefined;
try {
  configuredDatabase = parse(
    readFileSync(new URL("../.env.local", import.meta.url)),
  ).ACTIVITY_DB;
} catch {}
const database = resolve(
  root,
  process.env.ACTIVITY_DB ||
    configuredDatabase ||
    "../data/activity-checker/activity.sqlite",
);
const args = process.argv.slice(2);
const child = spawn(
  python,
  [
    script,
    args.shift() || "status",
    "--app",
    "activity-checker",
    "--database",
    database,
    ...args,
  ],
  { stdio: "inherit", cwd: root },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});

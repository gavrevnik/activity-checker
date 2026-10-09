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
const database =
  process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite";
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
  { stdio: "inherit" },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});

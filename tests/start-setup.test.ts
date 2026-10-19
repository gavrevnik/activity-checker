import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { parse } from "dotenv";

const root = resolve(import.meta.dirname, "..");
const directories: string[] = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-start-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const envFor = (dir: string) => {
  const env: NodeJS.ProcessEnv & { ACTIVITY_DB: string } = {
    ...process.env,
    ACTIVITY_DB: join(dir, "data", "activity.sqlite"),
  };
  for (const key of [
    "PORT",
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_PYTHON",
    "TELEGRAM_SESSION_PATH",
    "APIFY_TOKEN",
    "TICKETMASTER_API_KEY",
  ])
    delete env[key];
  return env;
};
const setup = (dir: string, args: string[]) =>
  execFileSync(
    process.execPath,
    [
      "--import",
      resolve(root, "node_modules/tsx/dist/loader.mjs"),
      resolve(root, "scripts/start-setup.ts"),
      ...args,
    ],
    { cwd: dir, env: envFor(dir), encoding: "utf8" },
  );

it("sets up a fresh personal DB without demos, and leaves existing data and profile intact on retry", () => {
  const dir = temporary(),
    path = envFor(dir).ACTIVITY_DB;
  setup(dir, ["--init"]);
  const db = new DatabaseSync(path);
  expect(
    db.prepare("SELECT value FROM settings WHERE key='demo-initialized'").get()
      ?.value,
  ).toBe("1");
  expect(
    db.prepare("SELECT count(*) n FROM recommendation_snapshots").get()?.n,
  ).toBe(0);
  db.prepare("UPDATE user_profile SET data=? WHERE id='main'").run(
    JSON.stringify({ custom: "Keep my own profile" }),
  );
  db.close();
  const before = readFileSync(path);
  expect(setup(dir, ["--init"])).toContain("без изменений");
  expect(readFileSync(path)).toEqual(before);
});

it("imports keys as data without shell execution, secret output or losing unrelated local settings", () => {
  const dir = temporary(),
    marker = join(dir, "executed");
  writeFileSync(join(dir, ".env.local"), "PORT=4329\nAPIFY_TOKEN=old\n");
  const secret = `$(touch ${marker})`;
  writeFileSync(join(dir, "keys.env"), `APIFY_TOKEN='${secret}'\n`);
  const output = setup(dir, ["--import-keys", "keys.env"]);
  expect(output).not.toContain(secret);
  expect(existsSync(marker)).toBe(false);
  expect(parse(readFileSync(join(dir, ".env.local")))).toEqual({
    PORT: "4329",
    APIFY_TOKEN: secret,
  });
  expect(statSync(join(dir, ".env.local")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "keys.env")).mode & 0o777).toBe(0o600);
});

it("diagnoses a clean clone before dependencies, without creating a DB or exposing configured keys", () => {
  const dir = temporary();
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    resolve(root, "scripts/start-check.mjs"),
    join(dir, "scripts/start-check.mjs"),
  );
  writeFileSync(join(dir, ".env.local"), "APIFY_TOKEN=private-value\nPORT=1\n");
  const output = execFileSync(process.execPath, ["scripts/start-check.mjs"], {
    cwd: dir,
    env: envFor(dir),
    encoding: "utf8",
  });
  const status = JSON.parse(output);
  expect(status.database.status).toBe("missing");
  expect(status.dependencies).toBe(false);
  expect(
    status.services.find(
      (service: { name: string }) => service.name === "Apify",
    ).status,
  ).toBe("configured-unverified");
  expect(output).not.toContain("private-value");
  expect(existsSync(envFor(dir).ACTIVITY_DB)).toBe(false);
});

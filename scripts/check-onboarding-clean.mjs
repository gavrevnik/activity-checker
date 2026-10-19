// Source-only rehearsal: no owner DB, env, session, global MCP or browser profile.
// Keeps the temporary directory for inspection; does not modify either checkout.
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "activity-clean-start-"));
for (const name of ["activity-checker", "personal-radar"]) {
  const repository = resolve(source, "..", name);
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repository, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    const allowed =
      name === "activity-checker"
        ? /^(?:src|server|shared|scripts|tests|migrations|skills|examples|data|docs|public|\.agents|Activity Checker\.app)\//.test(
            file,
          ) ||
          /^[^/]+\.(?:json|ts|md|html|txt)$/.test(file) ||
          file === ".env.example"
        : /^(?:connectors|catalog_sync|knowledge|workflows|docs)\//.test(
            file,
          ) || ["README.md", "AGENTS.md"].includes(file);
    if (
      !allowed ||
      /(?:^|\/)(?:node_modules|dist|\.runtime|\.venv[^/]*|__pycache__|\.git|SECRETS)(?:\/|$)|\.(?:sqlite[^/]*|session[^/]*|pyc)$/.test(
        file,
      ) ||
      /(?:^|\/)\.env(?!\.example$)/.test(file)
    )
      continue;
    const input = join(repository, file);
    if (!existsSync(input) || !statSync(input).isFile()) continue;
    const output = join(root, name, file);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(input, output);
  }
}
const home = join(root, "home");
mkdirSync(home);
const emptyConfig = join(home, "empty-npmrc");
writeFileSync(emptyConfig, "");
const globalConfig = join(home, "global-npmrc");
writeFileSync(globalConfig, "");
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  LANG: "en_US.UTF-8",
  TZ: "Europe/Chisinau",
  TMPDIR: process.env.TMPDIR || tmpdir(),
  CODEX_HOME: join(home, ".codex"),
  npm_config_userconfig: emptyConfig,
  npm_config_globalconfig: globalConfig,
  // Reuse only downloaded package artifacts, never owner configuration/credentials.
  npm_config_cache: join(homedir(), ".npm"),
  PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers"),
  UV_CACHE_DIR: join(root, "uv-cache"),
  UV_PYTHON_INSTALL_DIR: join(root, "python"),
  PORT: String(port),
};
const cwd = join(root, "activity-checker");
const checks = [];
function run(name, command, args) {
  console.log(`\n[clean-start] ${name}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout: 600_000,
  });
  checks.push({ name, ok: result.status === 0 && !result.error });
  if (result.error || result.status !== 0) {
    writeFileSync(
      join(root, "report.json"),
      JSON.stringify({ root, checks }, null, 2),
    );
    throw Error(`Clean setup failed: ${name}; inspect ${root}`);
  }
}
console.log(`[clean-start] ${root}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run("initial diagnostic", process.execPath, ["scripts/start-check.mjs"]);
run("install from lockfiles", npm, [
  "ci",
  "--no-audit",
  "--no-fund",
  "--offline",
]);
run("initialize own DB", npm, ["run", "start:setup", "--", "--init"]);
run("install own Chromium", npm, ["run", "browser:setup"]);
run("install own Python and Telegram connector", npm, [
  "run",
  "telegram:setup",
]);
run("verify tools and Chromium without credentials", npm, [
  "run",
  "start:verify",
]);
run("build", npm, ["run", "build"]);
console.log("\n[clean-start] production server and HTTP");
const web = spawn(
  process.execPath,
  ["--import", "tsx", "server/index.ts", "--production"],
  { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
);
let webLog = "";
web.stdout.on("data", (chunk) => {
  webLog += chunk;
});
web.stderr.on("data", (chunk) => {
  webLog += chunk;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(
        (r) => r.json(),
      );
      if (health.app === "activity-checker") {
        ready = true;
        break;
      }
    } catch {}
    if (web.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw Error("Clean server failed to start");
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then(
    (r) => r.json(),
  );
  if (
    !response.ok ||
    !(await response.text()).includes("<html") ||
    bootstrap.entities.length ||
    !bootstrap.profile.automaticFilters ||
    !bootstrap.profile.recommendationPrompts
  )
    throw Error("Clean service bootstrap failed");
  checks.push({ name: "production server and HTTP", ok: true });
} finally {
  const stopped = new Promise((done) => web.once("close", done));
  web.kill("SIGTERM");
  await stopped;
  writeFileSync(join(root, "web.log"), webLog);
}
run("full onboarding + profile + renderer + launcher contracts", npm, [
  "test",
  "--",
  "tests/onboarding-flow.test.tsx",
  "tests/start-setup.test.ts",
  "tests/profile-preferences.test.ts",
  "tests/local-browser.test.ts",
  "tests/launcher.test.ts",
]);
writeFileSync(
  join(root, "report.json"),
  JSON.stringify(
    {
      root,
      checks,
      notes:
        "Provider network replaced by synthetic Telegram/HTTPS fixtures. Real Node install, Python install, Chromium, local CLI, HTTP API, SQLite and UI rendering.",
    },
    null,
    2,
  ),
);
console.log(`\n[clean-start] PASSED; report: ${join(root, "report.json")}`);

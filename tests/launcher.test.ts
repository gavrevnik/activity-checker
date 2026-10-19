import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Execute the macOS launcher, replacing only OS commands; never open a browser,
// bind a port, start npm, or touch the user's running service/database.
const checkLauncher = (caddy: string, running = true, pinnedNode = false) => {
  const root = mkdtempSync(join(tmpdir(), "activity-launcher-"));
  directories.push(root);
  const launcher = join(
    root,
    "checkout/Activity Checker.app/Contents/MacOS/Activity Checker",
  );
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "checkout/Activity Checker.app/Contents/MacOS"), {
    recursive: true,
  });
  let source = readFileSync(
    resolve(
      import.meta.dirname,
      "../Activity Checker.app/Contents/MacOS/Activity Checker",
    ),
    "utf8",
  );
  const mocks = {
    curl: `
printf '%s\\n' "$*" >> "$MOCK_ROOT/curl-calls"
for url do :; done
case "$url" in
  http://127.0.0.1:4318/api/health)
    if [ "$MOCK_RUNNING" = no ] && [ ! -f "$MOCK_ROOT/started" ]; then exit 7; fi
    printf '%s' '{"ok":true,"app":"activity-checker"}' ;;
  http://activity-checker.localhost/api/health)
    case "$MOCK_CADDY" in
      ok) printf '%s' '{"ok":true,"app":"activity-checker"}' ;;
      wrong-app) printf '%s' '{"ok":true,"app":"jobs-checker"}' ;;
      timeout) exit 28 ;;
      *) exit 7 ;;
    esac ;;
  *) exit 1 ;;
esac`,
    open: `printf '%s' "$1" > "$MOCK_ROOT/opened"`,
    lsof: "exit 1",
    nohup: `: > "$MOCK_ROOT/started"`,
    sleep: "/bin/sleep 0.01",
    osascript: "exit 1",
  };
  for (const [command, body] of Object.entries(mocks)) {
    const path = join(root, "bin", command);
    writeFileSync(path, "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    source = source.replaceAll(
      command === "lsof"
        ? `/usr/sbin/${command}`
        : command === "sleep"
          ? `/bin/${command}`
          : `/usr/bin/${command}`,
      `'${path}'`,
    );
  }
  if (pinnedNode) {
    const bin = join(root, "custom-node/bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "checkout/.runtime"), { recursive: true });
    writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(root, "checkout/.runtime/node-bin"),
      join(bin, "node") + "\n",
    );
    source = source.replace(
      'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
      'export PATH="/usr/bin:/bin"',
    );
  }
  writeFileSync(launcher, source, { mode: 0o755 });
  execFileSync("/bin/zsh", [launcher], {
    env: {
      ...process.env,
      MOCK_ROOT: root,
      MOCK_CADDY: caddy,
      MOCK_RUNNING: running ? "yes" : "no",
    },
    timeout: 5000,
  });
  return {
    url: readFileSync(join(root, "opened"), "utf8"),
    started: existsSync(join(root, "started")),
    calls: readFileSync(join(root, "curl-calls"), "utf8"),
    pid: existsSync(join(root, "checkout/.runtime/web.pid")),
  };
};

it.skipIf(process.platform !== "darwin")(
  "opens the Caddy route when its health identifies Activity Checker",
  () => {
    const result = checkLauncher("ok");
    expect(result.url).toBe("http://activity-checker.localhost/");
    expect(result.started).toBe(false);
    expect(result.calls).toContain(
      "--resolve activity-checker.localhost:80:127.0.0.1",
    );
    expect(result.calls).toContain("--max-time 2");
  },
);

it
  .skipIf(process.platform !== "darwin")
  .each(["missing", "wrong-app", "timeout"])(
  "opens the direct URL for an already running service when Caddy is %s",
  (state) => {
    const result = checkLauncher(state);
    expect(result.url).toBe("http://127.0.0.1:4318/");
    expect(result.started).toBe(false);
  },
);

it.skipIf(process.platform !== "darwin").each(["ok", "missing"])(
  "selects the URL after starting a stopped service, with Caddy=%s",
  (state) => {
    const result = checkLauncher(state, false);
    expect(result.url).toBe(
      state === "ok"
        ? "http://activity-checker.localhost/"
        : "http://127.0.0.1:4318/",
    );
    expect(result.started).toBe(true);
    expect(result.pid).toBe(true);
  },
);

it.skipIf(process.platform !== "darwin")(
  "uses the Node installation saved by start when Finder has no npm in PATH",
  () => {
    const result = checkLauncher("missing", false, true);
    expect(result.started).toBe(true);
    expect(result.url).toBe("http://127.0.0.1:4318/");
  },
);

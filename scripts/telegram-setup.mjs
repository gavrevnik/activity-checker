import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args) => {
  const result = spawnSync("uv", args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error)
    throw Error(
      "uv не найден. Установите uv по https://docs.astral.sh/uv/getting-started/installation/ и повторите npm run telegram:setup.",
    );
  if (result.status) process.exit(result.status);
};
run(["venv", ".venv-telegram", "--python", "3.12"]);
run([
  "pip",
  "install",
  "--python",
  resolve(
    root,
    ".venv-telegram",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  ),
  "-r",
  "requirements-telegram.txt",
]);

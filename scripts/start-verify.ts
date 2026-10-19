import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { localBrowserStatus } from "../server/local-browser.js";
import { readSecrets } from "../server/secrets.js";
import { getTelegramToolStatus } from "../server/providers/telegram/tool.js";

const result: Record<string, unknown> = {
  tools: {},
  browser: localBrowserStatus(),
  telegram: "not-configured",
};
for (const route of ["research", "telegram"]) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/local-tool.ts", route, "--list"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
  );
  try {
    const data = JSON.parse(child.stdout);
    (result.tools as Record<string, unknown>)[route] = {
      available: child.status === 0,
      count: data.tools.length,
    };
  } catch {
    (result.tools as Record<string, unknown>)[route] = { available: false };
  }
}
if (localBrowserStatus().available) {
  try {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<p id="check"></p><script>document.querySelector("#check").textContent="ready"</script>',
      );
      if ((await page.locator("#check").textContent()) !== "ready")
        throw Error();
      result.browser = { ...localBrowserStatus(), verified: true };
    } finally {
      await browser.close();
    }
  } catch {
    result.browser = {
      ...localBrowserStatus(),
      available: false,
      verified: false,
      note: "Chromium не запускается: проверьте системные зависимости и права процесса.",
    };
  }
}
const secrets = readSecrets();
if (secrets.TELEGRAM_API_ID && secrets.TELEGRAM_API_HASH) {
  try {
    const status = await getTelegramToolStatus();
    result.telegram = { configured: true, authorized: status.authorized };
  } catch {
    result.telegram = {
      configured: true,
      authorized: false,
      note: "Проверьте Python-окружение и личный вход через npm run telegram:auth.",
    };
  }
}
console.log(JSON.stringify(result, null, 2));

const tools = result.tools as Record<string, { available: boolean }>;
if (
  !tools.research?.available ||
  !tools.telegram?.available ||
  !(result.browser as { verified?: boolean }).verified
)
  process.exitCode = 1;

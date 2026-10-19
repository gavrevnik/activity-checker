import { existsSync } from "node:fs";
import { chromium } from "playwright";
import type {
  BrowserRequest,
  BrowserCaller,
} from "@personal-radar/connectors/browser";
import { publicFetch, publicUrl } from "./public-fetch.js";
import { webSearch } from "@personal-radar/connectors/web";

export function localBrowserStatus() {
  return {
    available: existsSync(chromium.executablePath()),
    javascript: true,
    local: true,
    anonymous: true,
    setup: "npm run browser:setup",
  };
}

export async function readAnonymousPage(
  request: Extract<BrowserRequest, { action: "read" }>,
  fetcher = publicFetch,
) {
  const url = publicUrl(request.url).href;
  if (!localBrowserStatus().available)
    throw Error(
      "Локальный renderer не установлен. Выполните npm run browser:setup.",
    );
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--no-proxy-server",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  let requests = 0,
    bytes = 0;
  const signal = AbortSignal.timeout(30_000);
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
    });
    // Every HTTP byte passes through the pinned-DNS public transport. Chromium
    // never connects directly, uses no owner profile, and cannot send forms/cookies.
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
      try {
        const req = route.request();
        const target = publicUrl(req.url());
        if (
          req.method() !== "GET" ||
          ["image", "media", "font"].includes(req.resourceType()) ||
          ++requests > 80 ||
          bytes > 16 * 1024 * 1024
        )
          return void (await route.abort());
        const response = await fetcher(
          target,
          { method: "GET", redirect: "manual", signal },
          { maxBytes: 4 * 1024 * 1024 },
        );
        const body = Buffer.from(await response.arrayBuffer());
        bytes += body.length;
        if (bytes > 16 * 1024 * 1024) return void (await route.abort());
        const headers = Object.fromEntries(response.headers);
        for (const name of [
          "set-cookie",
          "content-length",
          "content-encoding",
          "alt-svc",
          "refresh",
        ])
          delete headers[name];
        if (headers.location) publicUrl(new URL(headers.location, target).href);
        await route.fulfill({ status: response.status, headers, body });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss());
    context.on("page", (popup) => {
      if (popup !== page) void popup.close();
    });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    await page.waitForTimeout(
      Math.min(Math.max(request.waitMs ?? 1200, 0), 5000),
    );
    publicUrl(page.url());
    const maxChars = Math.min(Math.max(request.maxChars, 1000), 30000);
    const result = await page.evaluate(
      ({ maxChars }) => {
        const full = document.body?.innerText || "";
        return {
          title: document.title,
          text: full.slice(0, maxChars),
          truncated: full.length > maxChars,
          links: Array.from(
            document.querySelectorAll<HTMLAnchorElement>("a[href]"),
          )
            .slice(0, 500)
            .map((a) => ({ title: a.innerText.trim(), url: a.href })),
          jsonLd: Array.from(
            document.querySelectorAll('script[type="application/ld+json"]'),
          )
            .map((s) => s.textContent || "")
            .filter((s) => s.length < 100000),
        };
      },
      { maxChars },
    );
    result.links = result.links.filter((link) => {
      try {
        publicUrl(link.url);
        return true;
      } catch {
        return false;
      }
    });
    const blocked =
      /captcha|verify (?:you are|that you are) human|checking your browser|access denied|just a moment/i.test(
        result.title + " " + result.text,
      ) || [401, 403, 429].includes(response?.status() || 0);
    return {
      ...result,
      url: page.url(),
      status: response?.status() || 0,
      rendered: true,
      blocked: blocked ? "captcha_or_access_denied" : null,
      fetchedAt: new Date().toISOString(),
      untrusted: true,
      requests,
    };
  } finally {
    await browser.close();
  }
}

export const localBrowserCall: BrowserCaller = async (request) => {
  if (request.action === "status") return localBrowserStatus();
  if (request.action === "search")
    return webSearch(request.query, request.count, publicFetch, "static");
  return readAnonymousPage(request);
};

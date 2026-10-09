import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { BlockList, isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import type { LookupFunction } from "node:net";

const deniedV4 = new BlockList();
const directAgent = new HttpsAgent({keepAlive: false});
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) deniedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001:db8::", 32], ["2001::", 32],
  ["2001:2::", 48], ["2001:10::", 28], ["2001:20::", 28], ["2002::", 16]] as const)
  deniedV6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !deniedV4.check(address, "ipv4") : family === 6 &&
    globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
}

export function publicUrl(value: string, hosts?: ReadonlySet<string>) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Некорректный URL публичной страницы."); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (value.length > 2048 || url.protocol !== "https:" || url.port && url.port !== "443" ||
    url.username || url.password || host.endsWith(".") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
    (!isIP(host) && !host.includes(".")) || (isIP(host) && !isPublicAddress(host)) ||
    (hosts && !hosts.has(host))) throw new Error("URL запрещён: разрешён только публичный HTTPS без credentials.");
  url.hash = "";
  return url;
}

type Address = { address: string; family: number };
type Options = { hosts?: ReadonlySet<string>; maxBytes?: number; maxRedirects?: number;
  resolve?: (host: string) => Promise<Address[]>; request?: typeof httpsRequest };

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Истекло время загрузки публичной страницы."));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

export async function publicFetch(input: string | URL | Request, init: RequestInit = {}, options: Options = {}): Promise<Response> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  if (input instanceof Request) throw new Error("Request objects are not supported by the restricted transport.");
  let url = publicUrl(String(input), options.hosts);
  const initialOrigin = url.origin;
  const timeout = AbortSignal.timeout(30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("HTTP method is not permitted.");
  if (init.body && typeof init.body !== "string") throw new Error("Only bounded JSON/form request bodies are supported.");
  if (typeof init.body === "string" && Buffer.byteLength(init.body) > 1024 * 1024) throw new Error("Request body exceeds limit.");
  for (let hop = 0; hop <= maxRedirects; hop++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(
      (options.resolve ?? (h => dnsLookup(h, { all: true, verbatim: true })))(host), signal);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address)))
      throw new Error("DNS указывает на локальный или служебный адрес; запрос отклонён.");
    // HTTPS uses the original hostname for TLS verification, but a pinned public
    // address for connecting. No second DNS resolution and no proxy environment.
    const pinnedLookup = ((hostname: string, opts: { all?: boolean }, callback: (...args: any[]) => void) => {
      if (hostname.replace(/^\[|\]$/g, "") !== host) return callback(new Error("Unexpected lookup hostname"));
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }) as LookupFunction;
    const response = await new Promise<Response>((resolve, reject) => {
      const headers = new Headers(init.headers);
      headers.set("accept-encoding", "identity");
      if (!headers.has("user-agent")) headers.set("user-agent", "ActivityChecker/0.1 (personal event research)");
      for (const key of ["host", "connection", "proxy-authorization", "proxy-connection"]) headers.delete(key);
      const req = (options.request ?? httpsRequest)(url, { method, signal, lookup: pinnedLookup, agent: directAgent,
        headers: Object.fromEntries(headers) }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(); reject(new Error("Ответ публичной страницы превышает лимит размера.")); }
          else chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("Публичная страница недоступна.")));
        res.on("end", () => {
          try {
            let body = Buffer.concat(chunks);
            const encoding = res.headers["content-encoding"];
            const limits = { maxOutputLength: maxBytes };
            if (encoding === "gzip") body = gunzipSync(body, limits);
            else if (encoding === "deflate") body = inflateSync(body, limits);
            else if (encoding === "br") body = brotliDecompressSync(body, limits);
            else if (encoding && encoding !== "identity") throw new Error();
            const responseHeaders = new Headers();
            for (let i = 0; i < res.rawHeaders.length; i += 2)
              if (!["content-encoding", "content-length"].includes(res.rawHeaders[i].toLowerCase()))
                responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
            const status = res.statusCode ?? 502;
            resolve(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(body),
              { status, headers: responseHeaders }));
          } catch { reject(new Error("Некорректный или слишком большой ответ публичной страницы.")); }
        });
      });
      req.on("error", () => reject(new Error(signal.aborted ? "Загрузка страницы отменена или истёк таймаут." : "Публичная страница недоступна.")));
      req.end(init.body ?? undefined);
    });
    Object.defineProperty(response, "url", {value: url.href});
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location || init.redirect === "manual") return response;
    if (init.redirect === "error" || hop === maxRedirects) throw new Error("Перенаправление публичной страницы отклонено.");
    const next = publicUrl(new URL(location, url).href, options.hosts);
    if (method !== "GET" || (next.origin !== initialOrigin && (init.headers || url.search)))
      throw new Error("Перенаправление запроса с параметрами или headers на другой origin запрещено.");
    url = next;
  }
  throw new Error("Слишком много перенаправлений.");
}

const budgets = new AsyncLocalStorage<{ hosts: ReadonlySet<string>; remaining: number; used: number }>();
let hooked = false;
export async function withAggregatorNetwork<T>(hosts: ReadonlySet<string>, maxRequests: number, task: () => Promise<T>) {
  if (!hooked) {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const budget = budgets.getStore();
      if (!budget) return original(input, init);
      if (budget.remaining <= 0) throw new Error("Достигнут лимит HTTP-запросов этого запуска; выборка не завершена.");
      budget.remaining -= 1;
      budget.used += 1;
      return publicFetch(input, { ...init, redirect: init?.redirect ?? "error" },
        { hosts: budget.hosts, maxBytes: 20 * 1024 * 1024 });
    };
    hooked = true;
  }
  const budget = { hosts, remaining: maxRequests, used: 0 };
  return budgets.run(budget, async () => ({ result: await task(), requestsUsed: budget.used }));
}

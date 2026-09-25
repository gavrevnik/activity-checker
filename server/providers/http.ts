import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export function isPrivateAddress(ip: string) {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v.includes(":"))
    return (
      v === "::" ||
      v === "::1" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      /^fe[89ab]/.test(v) ||
      v.startsWith("::ffff:") ||
      (!v.startsWith("2") && !v.startsWith("3"))
    );
  const n = v.split(".").map(Number);
  return (
    n[0] === 0 ||
    n[0] === 10 ||
    n[0] === 127 ||
    n[0] >= 224 ||
    (n[0] === 169 && n[1] === 254) ||
    (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
    (n[0] === 192 && n[1] === 168) ||
    (n[0] === 100 && n[1] >= 64 && n[1] <= 127) ||
    (n[0] === 198 && (n[1] === 18 || n[1] === 19))
  );
}
export async function validateRemote(url: string) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error(
      "Источник должен быть публичным HTTP(S) URL без credentials.",
    );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
    throw new Error(
      "Локальные и служебные сетевые адреса не допускаются для источников.",
    );
  return u;
}
export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeout = 45000,
): Promise<string> {
  const signal = AbortSignal.timeout(timeout);
  let current = url;
  const origin = new URL(url).origin;
  for (let hop = 0; hop < 4; hop++) {
    await validateRemote(current);
    const response = await fetch(current, {
      ...init,
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": "ActivityChecker/0.1 (personal local activity catalog)",
        ...init.headers,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw new Error("Сайт вернул redirect без URL.");
      current = new URL(next, current).href;
      if (
        new URL(current).origin !== origin &&
        (init.headers || new URL(url).search)
      )
        throw new Error("Перенаправление API на другой домен отклонено.");
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Источник ответил HTTP ${response.status}${response.status === 429 ? " · лимит запросов, повторите позже" : ""}`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Ответ источника превышает 20 МБ. Сузьте запрос.");
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Слишком много перенаправлений.");
}
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeout?: number,
): Promise<any> {
  const raw = await fetchText(url, init, timeout);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Источник вернул невалидный JSON.");
  }
}

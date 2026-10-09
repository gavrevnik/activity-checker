import { browserCall, type BrowserCaller } from "./browser-rpc.js";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { publicFetch, publicUrl } from "./public-fetch.js";

type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
function link(value: string, base: string) {
  try { return publicUrl(new URL(value, base).href).href; } catch { return null; }
}

async function staticRead(url: string, maxChars = 20000, fetcher: Fetcher = publicFetch) {
  const checked = publicUrl(url).href;
  const response = await fetcher(checked);
  const finalUrl = response.url ? publicUrl(response.url).href : checked;
  if (!response.ok) throw new Error(`Страница недоступна: HTTP ${response.status}; проверь другой источник.`);
  const type = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
  if (!/(?:html|text\/plain|application\/json)/.test(type)) throw new Error("Формат страницы не поддерживается; требуется HTML, текст или JSON.");
  const raw = await response.text();
  if (type === "text/plain" || type === "application/json") return {
    url: finalUrl, requestedUrl: checked, title: "", text: raw.slice(0, maxChars), truncated: raw.length > maxChars,
    links: [], structuredData: [], fetchedAt: new Date().toISOString(), untrusted: true,
  };
  const $ = load(raw);
  const title = clean($("title").first().text());
  const structuredData: unknown[] = [];
  $('script[type="application/ld+json"]').slice(0, 10).each((_, element) => {
    const text = $(element).text();
    if (text.length > 100000) return;
    try { structuredData.push(JSON.parse(text)); } catch {}
  });
  const links: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = link($(element).attr("href") || "", finalUrl);
    if (href && !seen.has(href) && links.length < 30) {
      seen.add(href); links.push({ title: clean($(element).text()).slice(0, 200), url: href });
    }
  });
  $("script,style,noscript,iframe,form,nav,footer,header").remove();
  const content = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
  const text = clean(content.text());
  return {url: finalUrl, requestedUrl: checked, title, text: text.slice(0, maxChars), truncated: text.length > maxChars,
    links, structuredData, fetchedAt: new Date().toISOString(), untrusted: true,
    limitations: "JavaScript не исполняется. Для закрытого или динамического контента прямо сообщи о недоступности."};
}

async function staticSearch(query: string, count = 5, fetcher: Fetcher = publicFetch) {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  let results: {title: string; url: string; snippet: string}[] = [];
  let provider = "duckduckgo";
  try {
    const response = await fetcher(url);
    if (!response.ok) throw new Error();
    const $ = load(await response.text());
    $(".result").each((_, element) => {
      const a = $(element).find(".result__a").first();
      if (!a.attr("href") || !clean(a.text())) return;
      let href = new URL(a.attr("href") || "", url);
      if ((href.hostname === "duckduckgo.com" || href.hostname.endsWith(".duckduckgo.com")) && href.searchParams.has("uddg"))
        href = new URL(href.searchParams.get("uddg")!);
      const checked = link(href.href, url);
      if (checked) results.push({title: clean(a.text()).slice(0, 300), url: checked,
        snippet: clean($(element).find(".result__snippet").text()).slice(0, 1000)});
    });
  } catch { results = []; }
  if (!results.length) {
    provider = "bing-rss";
    const response = await fetcher("https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query));
    if (!response.ok) throw new Error(`Поиск недоступен: HTTP ${response.status}. Сообщи о недоступности в чате.`);
    const rss = new XMLParser({ processEntities: false }).parse(await response.text());
    const items = rss?.rss?.channel?.item;
    for (const item of Array.isArray(items) ? items : items ? [items] : []) {
      const checked = typeof item.link === "string" ? link(item.link, "https://www.bing.com") : null;
      if (checked) results.push({title: clean(String(item.title ?? "")).slice(0, 300), url: checked,
        snippet: clean(String(item.description ?? "")).slice(0, 1000)});
    }
    if (!items) throw new Error("Поиск заблокирован или требует проверки пользователя. Сообщи об этом в чате.");
  }
  results = results.filter((value, index, all) => all.findIndex(v => v.url === value.url) === index).slice(0, count);
  return {query, provider, results, fetchedAt: new Date().toISOString(), untrusted: true};
}

export type RenderMode = "auto" | "static" | "browser";
export async function webStatus(browser:BrowserCaller=browserCall) {
  try {return {static:true,browser:await browser({action:"status"})};}
  catch {return {static:true,browser:{available:false},note:"Anonymous JavaScript worker unavailable; static HTTP remains usable."};}
}
export async function webRead(url:string,maxChars=20000,fetcher:Fetcher=publicFetch,render:RenderMode="auto",browser:BrowserCaller=browserCall) {
  const checked=publicUrl(url);
  const dynamicMaps=checked.hostname.startsWith("maps.google.") || checked.pathname.startsWith("/maps");
  if(render==="browser" || render==="auto" && dynamicMaps) return await browser({action:"read",url:checked.href,maxChars});
  let result:Awaited<ReturnType<typeof staticRead>>;
  try {result=await staticRead(checked.href,maxChars,fetcher);}
  catch(error) {if(render!=="auto" || fetcher!==publicFetch)throw error;return await browser({action:"read",url:checked.href,maxChars});}
  if(render==="auto" && fetcher===publicFetch && (result.text.length<250 || /enable.*javascript|requires? javascript|включит.*javascript/i.test(result.text))) {
    try {return await browser({action:"read",url:checked.href,maxChars});} catch {return {...result,rendered:false,javascriptFallbackUnavailable:true};}
  }
  return {...result,rendered:false};
}
export function rankSearchResults(query:string,values:{title:string;url:string;snippet:string}[],count:number) {
  const terms=[...new Set(query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])].filter(t=>!["the","and","for","with","https","www","com"].includes(t));
  return values.map(value=>({...value,matchedQueryTerms:terms.filter(t=>(value.title+" "+value.snippet+" "+value.url).toLocaleLowerCase().includes(t)).length})).filter(value=>value.matchedQueryTerms>=Math.min(2,terms.length)).sort((a,b)=>b.matchedQueryTerms-a.matchedQueryTerms).slice(0,count);
}
export async function webSearch(query:string,count=5,fetcher:Fetcher=publicFetch,render:RenderMode="auto",browser:BrowserCaller=browserCall) {
  let browserAttempts:unknown;
  if(render!=="static" && fetcher===publicFetch) {
    try {
      const result=await browser({action:"search",query,count});
      if(Array.isArray(result.results)&&result.results.length)return result;
      browserAttempts=result.attempts;
      if(render==="browser")return result;
    } catch(error) {if(render==="browser")throw error;}
  }
  const result=await staticSearch(query,Math.max(count,10),fetcher);
  const results=rankSearchResults(query,result.results,count);
  return {...result,results,browserAttempts,rendered:false,...(!results.length?{blocked:"no_relevant_results",note:"Поиск не дал релевантных результатов. Не используйте нерелевантный RSS как подтверждение рейтинга."}:{})};
}

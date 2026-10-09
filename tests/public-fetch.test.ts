import {describe, expect, it} from "vitest";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {gzipSync} from "node:zlib";
import {request as httpsRequest} from "node:https";
import {isPublicAddress, publicFetch, publicUrl} from "../server/public-fetch";
import {webRead, webSearch} from "../server/research-web";

function transport(body: Buffer | string, status = 200, headers: Record<string,string> = {}) {
  const observed: {url: URL; options: any}[] = [];
  const request = ((url: URL, options: any, callback: (response: any) => void) => {
    observed.push({url, options});
    const req = new EventEmitter() as any;
    req.destroy = () => { req.emit("error", new Error("closed")); };
    req.end = () => {
      const res = Object.assign(new PassThrough(), {headers, statusCode: status,
        rawHeaders: Object.entries(headers).flat()});
      callback(res);
      queueMicrotask(() => res.end(body));
    };
    return req;
  }) as typeof httpsRequest;
  return {request, observed};
}
const resolve = async () => [{address: "1.1.1.1", family: 4}];

describe("public research transport", () => {
  it("rejects local, metadata, reserved and mapped IPv6 targets", () => {
    for (const value of ["127.0.0.1","10.2.3.4","169.254.169.254","100.64.0.1","198.18.0.1",
      "192.168.1.2","0.0.0.0","224.0.0.1","::1","fc00::1","fe80::1","2001:db8::1","::ffff:127.0.0.1"])
      expect(isPublicAddress(value), value).toBe(false);
    for (const value of ["1.1.1.1","8.8.8.8","2606:4700:4700::1111"]) expect(isPublicAddress(value)).toBe(true);
    for (const url of ["file:///etc/passwd","http://example.org","https://localhost/","https://localhost./",
      "https://127.1/","https://2130706433/","https://[::1]/","https://user:secret@example.org/","https://example.org:8443/"])
      expect(() => publicUrl(url)).toThrow();
  });
  it("pins the validated address into TLS connection lookup", async () => {
    const fake = transport("ok");
    const response = await publicFetch("https://example.org/event", {}, {...fake, resolve});
    expect(await response.text()).toBe("ok");
    let address;
    fake.observed[0].options.lookup("example.org", {}, (_: unknown, value: string) => {address = value;});
    expect(address).toBe("1.1.1.1");
    expect(fake.observed[0].url.hostname).toBe("example.org");
    expect(fake.observed[0].options.headers["accept-encoding"]).toBe("identity");
  });
  it("rejects mixed private DNS answers before any connection", async () => {
    const fake = transport("should not load");
    await expect(publicFetch("https://example.org/", {}, {...fake,
      resolve: async () => [{address:"1.1.1.1",family:4},{address:"127.0.0.1",family:4}]})).rejects.toThrow("DNS");
    expect(fake.observed).toHaveLength(0);
  });
  it("denies private redirects and cross-host API credential forwarding", async () => {
    for (const next of ["https://127.0.0.1/", "https://other.example/"]) {
      const fake = transport("", 302, {location: next});
      await expect(publicFetch("https://example.org/", {headers:{"x-api-key":"synthetic"}},
        {...fake, resolve})).rejects.toThrow();
      expect(fake.observed).toHaveLength(1);
    }
  });
  it("caps both downloaded and decompressed bytes", async () => {
    for (const [body, headers] of [[Buffer.alloc(4096), {}], [gzipSync(Buffer.alloc(4096)), {"content-encoding":"gzip"}]] as const) {
      const fake = transport(body, 200, headers);
      await expect(publicFetch("https://example.org/", {}, {...fake, resolve, maxBytes:1024})).rejects.toThrow();
    }
  });
});

describe("event web evidence", () => {
  it("extracts dates, public links and JSON-LD without script or form execution", async () => {
    const html = '<title>Jazz night</title><main>Концерт 10 октября в 20:00<a href="/tickets">Билеты</a><a href="http://localhost/">private</a></main>' +
      '<script>stealCredentials()</script><form>submit secret</form><script type="application/ld+json">{"@type":"Event","startDate":"2026-10-10T20:00"}</script>';
    const result = await webRead("https://example.org/event", 20000, async () => new Response(html, {headers:{"content-type":"text/html"}}));
    expect(result.text).toContain("20:00");
    expect(result.text).not.toContain("stealCredentials");
    expect(result.text).not.toContain("submit secret");
    expect(result.links).toEqual([{title:"Билеты",url:"https://example.org/tickets"}]);
    expect(result.structuredData).toEqual([{"@type":"Event",startDate:"2026-10-10T20:00"}]);
    expect(result.untrusted).toBe(true);
  });
  it("unwraps search links and falls back on a blocked search frontend", async () => {
    const html = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fevent">Jazz</a><div class="result__snippet">Belgrade October 10</div></div>';
    const direct = await webSearch("Belgrade jazz", 5, async () => new Response(html));
    expect(direct.results[0].url).toBe("https://example.org/event");
    const calls: string[] = [];
    const fallback = await webSearch("Belgrade jazz", 5, async url => {
      calls.push(String(url));
      return calls.length === 1 ? new Response("captcha",{status:403}) : new Response('<rss><channel><item><title>Jazz</title><link>https://example.org/event</link><description>Belgrade October 10</description></item></channel></rss>');
    });
    expect(fallback.provider).toBe("bing-rss");
    expect(fallback.results).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
  it("resolves event links against the final redirected page URL",async()=>{
    const response=new Response('<main><a href="tickets">Tickets</a></main>',{headers:{"content-type":"text/html"}});
    Object.defineProperty(response,"url",{value:"https://example.org/events/jazz/"});
    const result=await webRead("https://example.org/old",20000,async()=>response);
    expect(result.url).toBe("https://example.org/events/jazz/");
    expect(result.links[0].url).toBe("https://example.org/events/jazz/tickets");
  });
});

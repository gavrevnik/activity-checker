import { expect, it, vi } from "vitest";
import {
  localBrowserStatus,
  readAnonymousPage,
} from "../server/local-browser.js";

it.skipIf(!localBrowserStatus().available)(
  "renders JavaScript through the public transport, without cookies, writes or private network",
  async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        expect(init?.method).toBe("GET");
        expect(init?.headers).toBeUndefined();
        if (url.endsWith("/events.json"))
          return new Response(
            JSON.stringify({ title: "Concert în limba română" }),
            { headers: { "content-type": "application/json" } },
          );
        return new Response(
          `<html><head><title>Calendar</title></head><body><p id="event">Loading</p><a href="https://example.org/event">Bilete</a><a href="https://127.0.0.1/secret">Private</a><script>
      fetch('/events.json').then(r=>r.json()).then(e=>document.querySelector('#event').textContent=e.title);
      fetch('https://127.0.0.1/secret').catch(()=>{});
      fetch('/write',{method:'POST',body:'not-permitted'}).catch(()=>{});
      document.cookie='untrusted=value';
      </script></body></html>`,
          {
            headers: {
              "content-type": "text/html",
              "set-cookie": "owner=must-not-persist",
            },
          },
        );
      },
    );
    const result = await readAnonymousPage(
      {
        action: "read",
        url: "https://example.org/calendar",
        maxChars: 2000,
        waitMs: 300,
      },
      fetcher,
    );
    expect(result.text).toContain("Concert în limba română");
    expect(result.rendered).toBe(true);
    expect(calls).toContain("https://example.org/events.json");
    expect(
      calls.some((url) => url.includes("127.0.0.1") || url.endsWith("/write")),
    ).toBe(false);
    expect(result.links.some((link) => link.url.includes("127.0.0.1"))).toBe(
      false,
    );
  },
  15000,
);

it("rejects a private initial URL before launching Chromium or doing HTTP", async () => {
  const fetcher = vi.fn();
  await expect(
    readAnonymousPage(
      { action: "read", url: "https://127.0.0.1/", maxChars: 1000 },
      fetcher,
    ),
  ).rejects.toThrow(/URL/);
  expect(fetcher).not.toHaveBeenCalled();
});

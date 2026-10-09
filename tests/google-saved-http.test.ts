import { expect, it } from "vitest";
import { createServer } from "node:http";
import { Store } from "../server/store";
import { createApi } from "../server/api";
it("imports Takeout on an isolated HTTP server, preserves the index after bad import and guards origins", async () => {
  const store = new Store(":memory:"),
    server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const port = address.port;
  server.on("request", createApi(store, port));
  const base = `http://127.0.0.1:${port}/api/google-saved`;
  try {
    const before = await (await fetch(base + "/status")).json();
    expect(before.items).toBe(0);
    const post = (body: unknown, origin?: string) =>
      fetch(base + "/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
      });
    const input = {
      filename: "Known.csv",
      base64: Buffer.from(
        "title,url,note\nCafe,https://www.google.com/maps/?cid=777,coffee\n",
      ).toString("base64"),
    };
    expect((await post(input, "https://evil.example")).status).toBe(403);
    const good = await post(input);
    expect(good.status).toBe(200);
    expect((await good.json()).items).toBe(1);
    expect(
      (
        await post({
          filename: "bad.csv",
          base64: Buffer.from("not csv").toString("base64"),
        })
      ).status,
    ).toBe(400);
    expect((await (await fetch(base + "/status")).json()).items).toBe(1);
    const read = await (await fetch(base + "/items?query=Cafe")).json();
    expect(read.items[0]).toMatchObject({
      title: "Cafe",
      note: "coffee",
      cid: "777",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

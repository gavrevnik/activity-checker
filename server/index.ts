import { parse } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { Store } from "./store.js";
import { createApi } from "./api.js";
import { seedDemo } from "./demo.js";
let runtime: Record<string, string> = {};
try {
  runtime = parse(readFileSync(".env.local"));
} catch {}
const port = Number(process.env.PORT || runtime.PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT должен быть от 1024 до 65535");
const store = new Store(
  process.env.ACTIVITY_DB ||
    runtime.ACTIVITY_DB ||
    "../data/activity-checker/activity.sqlite",
);
seedDemo(store);
const app = createApi(store, port);
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: {
      middlewareMode: true,
      hmr: { port: port + 1, host: "127.0.0.1" },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`Activity Checker · http://127.0.0.1:${port}`),
);
server.on("error", (error) => {
  console.error(error.message);
  store.close();
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );

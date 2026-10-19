import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crawlStateStore } from "../server/providers/websites/moldova-crawl-state.js";
import {
  selectionKey,
  type CrawlState,
} from "@personal-radar/connectors/moldova-events";
it("persists independent source/range checkpoints without using a live database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "md-crawl-"));
  try {
    const one = crawlStateStore(
        "source",
        "fest-md",
        "2026-10-16",
        "2026-12-31",
        dir,
      ),
      other = crawlStateStore(
        "source",
        "fest-md",
        "2026-11-01",
        "2026-12-31",
        dir,
      );
    const state: CrawlState = {
      version: 2,
      catalog: "fest-md",
      selection: selectionKey("fest-md", "2026-10-16", "2026-12-31"),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cursor: 1,
      queue: [
        { url: "https://www.fest.md/ru/events/concerts/one" },
        { url: "https://www.fest.md/ru/events/concerts/two" },
      ],
      discoveryComplete: true,
      events: [],
      unresolved: [],
      warnings: [],
    };
    await one.save(state);
    expect(await one.load()).toMatchObject({ cursor: 1 });
    expect(await other.load()).toBeUndefined();
    expect(
      await crawlStateStore(
        "another",
        "fest-md",
        "2026-10-16",
        "2026-12-31",
        dir,
      ).load(),
    ).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

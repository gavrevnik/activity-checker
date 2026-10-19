import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  selectionKey,
  type Catalog,
  type CrawlState,
} from "@personal-radar/connectors/moldova-events";
const root = fileURLToPath(
  new URL("../../../.runtime/provider-crawls/", import.meta.url),
);
export function crawlStateStore(
  sourceId: string,
  catalog: Catalog,
  from = "",
  to = "",
  directory = root,
) {
  const key = selectionKey(catalog, from, to);
  const file = join(
    directory,
    createHash("sha256")
      .update(JSON.stringify([sourceId, key]))
      .digest("hex") + ".json",
  );
  return {
    async load(): Promise<CrawlState | undefined> {
      try {
        const state = JSON.parse(await readFile(file, "utf8")) as CrawlState;
        if (
          state.version !== 2 ||
          state.catalog !== catalog ||
          state.selection !== key
        )
          throw Error("Неверный checkpoint");
        // Completed scans refresh after six hours; incomplete scans always resume.
        if (
          state.discoveryComplete &&
          state.cursor === state.queue.length &&
          Date.now() - Date.parse(state.updatedAt) > 6 * 3600_000
        )
          return undefined;
        return state;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    async save(state: CrawlState) {
      await mkdir(directory, { recursive: true });
      const tmp = file + "." + randomUUID() + ".tmp";
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, file);
    },
  };
}

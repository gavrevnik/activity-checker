import { fileURLToPath } from "node:url";
import { createBrowserCaller } from "@personal-radar/connectors/browser";
export type {
  BrowserRequest,
  BrowserCaller,
} from "@personal-radar/connectors/browser";
export const browserCall = createBrowserCaller(
  process.env.ACTIVITY_BROWSER_SOCKET ||
    fileURLToPath(
      new URL("../../.agent-stack-tmp/browser-read.sock", import.meta.url),
    ),
);

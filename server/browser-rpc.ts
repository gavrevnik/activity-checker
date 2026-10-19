import { createBrowserCaller } from "@personal-radar/connectors/browser";
import { localBrowserCall } from "./local-browser.js";
export type {
  BrowserRequest,
  BrowserCaller,
} from "@personal-radar/connectors/browser";
// Standalone by default. An explicitly configured existing sidecar remains usable.
export const browserCall = process.env.ACTIVITY_BROWSER_SOCKET
  ? createBrowserCaller(process.env.ACTIVITY_BROWSER_SOCKET)
  : localBrowserCall;

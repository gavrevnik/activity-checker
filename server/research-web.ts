import {
  webRead as read,
  webSearch as search,
  webStatus as status,
} from "@personal-radar/connectors/web";
import { browserCall } from "./browser-rpc.js";
import { publicFetch } from "./public-fetch.js";
export { rankSearchResults } from "@personal-radar/connectors/web";
export type { RenderMode } from "@personal-radar/connectors/web";
export const webStatus = (browser = browserCall) => status(browser);
export const webRead = (
  url: string,
  maxChars = 20000,
  fetcher = publicFetch,
  render: import("@personal-radar/connectors/web").RenderMode = "auto",
  browser = browserCall,
) => read(url, maxChars, fetcher, render, browser);
export const webSearch = (
  query: string,
  count = 5,
  fetcher = publicFetch,
  render: import("@personal-radar/connectors/web").RenderMode = "auto",
  browser = browserCall,
) => search(query, count, fetcher, render, browser);

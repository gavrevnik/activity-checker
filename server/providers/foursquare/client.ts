import { searchFoursquarePlaces as search } from "@personal-radar/connectors/foursquare";
import { reserveFoursquareRequest } from "./quota.js";
export * from "@personal-radar/connectors/foursquare";
export const searchFoursquarePlaces = (input: Parameters<typeof search>[0]) =>
  search(input, reserveFoursquareRequest);

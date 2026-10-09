import { searchGooglePlacesText as search } from "@personal-radar/connectors/google-places";
import { reserveMcpRequest } from "./mcp-budget.js";
import {
  reserveGooglePlacesRequest,
  finishGooglePlacesRequest,
  googlePlacesQuotaStatus,
} from "./quota.js";
import type { Store } from "../../store.js";
export * from "@personal-radar/connectors/google-places";
export function searchGooglePlacesText(
  input: Parameters<typeof search>[0],
  store: Store,
) {
  return search(input, {
    reserve: (mode, query, sourceId) => {
      reserveMcpRequest(mode);
      return reserveGooglePlacesRequest(store, mode, query, sourceId);
    },
    finish: (id, status, count, error) =>
      finishGooglePlacesRequest(store, id, status, count, error),
    status: () => googlePlacesQuotaStatus(store),
  });
}

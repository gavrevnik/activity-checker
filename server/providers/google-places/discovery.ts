import { mcpCanRequest } from "./mcp-budget.js";
import { knownGooglePlace } from "../../google-saved.js";
import type { Store } from "../../store.js";
import { searchGooglePlacesText, type GooglePlace } from "./client.js";
import type { GooglePlacesSku } from "./quota.js";

export interface GooglePlacesBatchOptions {
  store: Store;
  apiKey: string;
  sourceId: string;
  queries: string[];
  location: string;
  mode: GooglePlacesSku;
  minRating: number;
  resultsPerQuery: number;
  maxItems: number;
  newOnly?: boolean;
}

export function normalizeGooglePlacesQueries(values: string[]) {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 30);
}

export function googlePlaceEntityId(store: Store, placeId: string) {
  const suffix = `:id:google_place:${placeId}`;
  const row = store.db
    .prepare(
      "SELECT entityId FROM entity_keys WHERE substr(key,-length(?))=? LIMIT 1",
    )
    .get(suffix, suffix) as { entityId: string } | undefined;
  return row?.entityId || null;
}

export function rememberGooglePlaceIds(
  store: Store,
  query: string,
  places: GooglePlace[],
) {
  const stamp = new Date().toISOString();
  return places.map((place) => {
    const before = store.db
      .prepare(
        "SELECT displayName,matchedQueries,proFetchedAt,enterpriseFetchedAt FROM google_places_discovered_ids WHERE placeId=?",
      )
      .get(place.id) as
      | {
          displayName: string;
          matchedQueries: string;
          proFetchedAt: string | null;
          enterpriseFetchedAt: string | null;
        }
      | undefined;
    const matchedQueries = new Set<string>(
      before ? (JSON.parse(before.matchedQueries) as string[]) : [],
    );
    matchedQueries.add(query);
    const displayName = place.displayName?.text.trim() || "";
    store.db
      .prepare(
        "INSERT INTO google_places_discovered_ids(placeId,displayName,firstQuery,matchedQueries,firstSeenAt,lastSeenAt) VALUES (?,?,?,?,?,?) ON CONFLICT(placeId) DO UPDATE SET displayName=CASE WHEN excluded.displayName<>'' THEN excluded.displayName ELSE google_places_discovered_ids.displayName END,matchedQueries=excluded.matchedQueries,lastSeenAt=excluded.lastSeenAt",
      )
      .run(
        place.id,
        displayName,
        query,
        JSON.stringify([...matchedQueries]),
        stamp,
        stamp,
      );
    const entityId = googlePlaceEntityId(store, place.id);
    return {
      placeId: place.id,
      entityId,
      knownInEntities: Boolean(entityId),
      previouslyDiscovered: Boolean(before),
      displayName: displayName || before?.displayName || "",
      proFetched: Boolean(before?.proFetchedAt),
      enterpriseFetched: Boolean(before?.enterpriseFetchedAt),
      isNewCandidate: !knownGooglePlace(store, place),
    };
  });
}

function markFetched(store: Store, placeIds: string[], mode: GooglePlacesSku) {
  if (mode === "ids_only" || !placeIds.length) return;
  const column = mode === "pro" ? "proFetchedAt" : "enterpriseFetchedAt";
  const statement = store.db.prepare(
    `UPDATE google_places_discovered_ids SET ${column}=?,lastSeenAt=? WHERE placeId=?`,
  );
  const stamp = new Date().toISOString();
  store.transaction(() => {
    for (const id of placeIds) statement.run(stamp, stamp, id);
  });
}

function validProPlace(place: GooglePlace) {
  return Boolean(
    place.displayName?.text.trim() &&
    place.location &&
    Number.isFinite(place.location.latitude) &&
    Number.isFinite(place.location.longitude),
  );
}

export async function executeGooglePlacesBatch(
  options: GooglePlacesBatchOptions,
) {
  const queries = normalizeGooglePlacesQueries(options.queries);
  const found = new Map<
    string,
    { place: GooglePlace; matchedQueries: string[] }
  >();
  const queryResults: Array<{
    query: string;
    returned: number;
    newIds: number;
    existingIds: number;
  }> = [];
  for (const query of queries) {
    if (!mcpCanRequest()) break;
    const result = await searchGooglePlacesText(
      {
        query,
        location: options.location,
        mode: options.mode,
        minRating: options.minRating,
        pageSize: options.resultsPerQuery,
        apiKey: options.apiKey,
        sourceId: options.sourceId,
      },
      options.store,
    );
    const statuses = rememberGooglePlaceIds(
      options.store,
      query,
      result.places,
    );
    markFetched(
      options.store,
      result.places.map((place) => place.id),
      options.mode,
    );
    queryResults.push({
      query,
      returned: result.places.length,
      newIds: statuses.filter((status) => status.isNewCandidate).length,
      existingIds: statuses.filter((status) => status.knownInEntities).length,
    });
    for (const place of result.places) {
      if (options.newOnly && knownGooglePlace(options.store, place)) continue;
      const existing = found.get(place.id);
      if (existing) existing.matchedQueries.push(query);
      else found.set(place.id, { place, matchedQueries: [query] });
      if (found.size >= options.maxItems) break;
    }
    if (found.size >= options.maxItems) break;
  }
  return {
    mode: options.mode,
    queries: queryResults,
    results: [...found.values()],
  };
}

export async function executeGooglePlacesDiscovery(
  options: Omit<GooglePlacesBatchOptions, "mode"> & {
    minValidResultsPerQuery?: number;
  },
) {
  const queries = normalizeGooglePlacesQueries(options.queries);
  const idPass: Array<{
    query: string;
    returned: number;
    newPlaceIds: string[];
    knownPlaceIds: string[];
  }> = [];
  const candidates = new Map<string, Set<string>>();

  for (const query of queries) {
    if (!mcpCanRequest()) break;
    const result = await searchGooglePlacesText(
      {
        query,
        location: options.location,
        mode: "ids_only",
        minRating: options.minRating,
        pageSize: options.resultsPerQuery,
        apiKey: options.apiKey,
        sourceId: options.sourceId,
      },
      options.store,
    );
    const statuses = rememberGooglePlaceIds(
      options.store,
      query,
      result.places,
    );
    const newPlaceIds = statuses
      .filter((status) => status.isNewCandidate)
      .map((status) => status.placeId);
    const knownPlaceIds = statuses
      .filter((status) => !status.isNewCandidate)
      .map((status) => status.placeId);
    idPass.push({
      query,
      returned: result.places.length,
      newPlaceIds,
      knownPlaceIds,
    });
    if (newPlaceIds.length) candidates.set(query, new Set(newPlaceIds));
  }

  const found = new Map<
    string,
    { place: GooglePlace; matchedQueries: string[] }
  >();
  const proPass: Array<{
    query: string;
    returned: number;
    candidateMatches: number;
    valid: number;
    accepted: boolean;
  }> = [];
  const minimumValid = options.minValidResultsPerQuery || 1;

  for (const [query, candidateIds] of candidates) {
    if (found.size >= options.maxItems || !mcpCanRequest()) break;
    const result = await searchGooglePlacesText(
      {
        query,
        location: options.location,
        mode: "pro",
        minRating: options.minRating,
        pageSize: options.resultsPerQuery,
        apiKey: options.apiKey,
        sourceId: options.sourceId,
      },
      options.store,
    );
    rememberGooglePlaceIds(options.store, query, result.places);
    markFetched(
      options.store,
      result.places.map((place) => place.id),
      "pro",
    );
    const candidateMatches = result.places.filter((place) =>
      candidateIds.has(place.id),
    );
    const valid = candidateMatches.filter(
      (place) =>
        validProPlace(place) && !knownGooglePlace(options.store, place),
    );
    const accepted = valid.length >= minimumValid;
    proPass.push({
      query,
      returned: result.places.length,
      candidateMatches: candidateMatches.length,
      valid: valid.length,
      accepted,
    });
    if (!accepted) continue;
    for (const place of valid) {
      const existing = found.get(place.id);
      if (existing) existing.matchedQueries.push(query);
      else found.set(place.id, { place, matchedQueries: [query] });
      if (found.size >= options.maxItems) break;
    }
  }

  return {
    mode: "ids_then_pro" as const,
    idPass,
    proPass,
    productiveQueries: [...candidates.keys()],
    results: [...found.values()],
  };
}

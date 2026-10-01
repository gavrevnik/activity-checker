ALTER TABLE sources
ADD COLUMN minRating REAL NOT NULL DEFAULT 4
CHECK(minRating >= 0 AND minRating <= 5);

CREATE TABLE google_places_api_usage (
  id TEXT PRIMARY KEY,
  billingMonth TEXT NOT NULL,
  sku TEXT NOT NULL CHECK(sku IN ('ids_only','pro','enterprise')),
  weightUnits INTEGER NOT NULL CHECK(weightUnits IN (0,1,5)),
  query TEXT NOT NULL,
  sourceId TEXT,
  requestedAt TEXT NOT NULL,
  completedAt TEXT,
  outcome TEXT NOT NULL DEFAULT 'reserved'
    CHECK(outcome IN ('reserved','success','error')),
  resultCount INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX google_places_usage_month_sku
ON google_places_api_usage(billingMonth, sku);

CREATE TABLE google_places_discovered_ids (
  placeId TEXT PRIMARY KEY,
  firstQuery TEXT NOT NULL,
  matchedQueries TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(matchedQueries)),
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  proFetchedAt TEXT,
  enterpriseFetchedAt TEXT
);

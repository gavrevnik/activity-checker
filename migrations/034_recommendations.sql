CREATE TABLE recommendation_snapshots (
  id TEXT PRIMARY KEY,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  kind TEXT NOT NULL CHECK(kind IN ('week', 'concerts-2026')),
  data TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX recommendation_latest ON recommendation_snapshots(scopeId, kind, updatedAt DESC);

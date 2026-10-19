CREATE TABLE recommendation_snapshots_next (
  id TEXT PRIMARY KEY,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  kind TEXT NOT NULL CHECK(kind IN ('week', 'next-week', 'concerts-2026')),
  data TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
INSERT INTO recommendation_snapshots_next SELECT * FROM recommendation_snapshots;
DROP TABLE recommendation_snapshots;
ALTER TABLE recommendation_snapshots_next RENAME TO recommendation_snapshots;
CREATE INDEX recommendation_latest ON recommendation_snapshots(scopeId, kind, updatedAt DESC);

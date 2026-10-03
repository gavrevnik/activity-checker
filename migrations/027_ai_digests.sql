CREATE TABLE ai_digests (
  id TEXT PRIMARY KEY,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  archivedAt TEXT
);
CREATE INDEX ai_digests_scope_dates ON ai_digests(scopeId, archivedAt, endDate, startDate);

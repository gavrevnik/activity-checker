CREATE TABLE recommendation_favorites (
  id TEXT PRIMARY KEY,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  data TEXT NOT NULL,
  addedAt TEXT NOT NULL
);
CREATE INDEX recommendation_favorites_scope ON recommendation_favorites(scopeId);

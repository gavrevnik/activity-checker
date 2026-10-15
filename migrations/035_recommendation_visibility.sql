CREATE TABLE recommendation_visibility (
  id TEXT PRIMARY KEY,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  data TEXT NOT NULL,
  hidden INTEGER NOT NULL CHECK(hidden IN (0, 1)),
  hiddenAt TEXT NOT NULL
);
CREATE INDEX recommendation_visibility_scope ON recommendation_visibility(scopeId, hidden);

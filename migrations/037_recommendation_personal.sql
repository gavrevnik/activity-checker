CREATE TABLE recommendation_personal (
  id TEXT PRIMARY KEY,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  data TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX recommendation_personal_scope ON recommendation_personal(scopeId);

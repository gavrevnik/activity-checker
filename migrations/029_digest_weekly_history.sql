CREATE TABLE IF NOT EXISTS digest_weekly_history (
  runId TEXT NOT NULL,
  scopeId TEXT NOT NULL REFERENCES scopes(id),
  weekStart TEXT NOT NULL,
  recordKind TEXT NOT NULL CHECK(recordKind IN ('run','observation','publication')),
  eventKey TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases)),
  facts TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(facts)),
  payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
  state TEXT NOT NULL CHECK(state IN ('observed','prepared','delivered','unknown')),
  windowStart TEXT NOT NULL,
  windowEnd TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  deliveredAt TEXT,
  nativeRunId TEXT,
  PRIMARY KEY(runId,recordKind,eventKey)
);
CREATE INDEX IF NOT EXISTS digest_weekly_history_week ON digest_weekly_history(scopeId,weekStart,recordKind,state);
CREATE INDEX IF NOT EXISTS digest_weekly_history_event ON digest_weekly_history(scopeId,eventKey,recordKind,createdAt);

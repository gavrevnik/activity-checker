CREATE TABLE telegram_query_history (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  executedAt TEXT NOT NULL,
  operation TEXT NOT NULL,
  query TEXT NOT NULL,
  minParticipants INTEGER NOT NULL DEFAULT 0,
  resultsPerQuery INTEGER NOT NULL,
  returnedCount INTEGER NOT NULL DEFAULT 0,
  relevantCount INTEGER,
  storedCount INTEGER NOT NULL DEFAULT 0,
  resultUsernames TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX telegram_query_history_lookup
  ON telegram_query_history(operation, query, executedAt DESC);
CREATE INDEX telegram_query_history_run
  ON telegram_query_history(runId);

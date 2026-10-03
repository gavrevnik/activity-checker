CREATE TABLE ai_mcp_discovery_query_history (
  queryId TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  updatedAt TEXT NOT NULL
);

CREATE TABLE ai_mcp_discovery_summary (
  id TEXT PRIMARY KEY CHECK(id = 'main'),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 5000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updatedAt TEXT NOT NULL
);
INSERT INTO ai_mcp_discovery_summary (id, summary, revision, updatedAt)
VALUES ('main', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Namespaced receipts also reference pre-existing provider history without copying it.
CREATE TABLE ai_mcp_discovery_evidence (
  queryId TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  conclusion TEXT NOT NULL CHECK(length(conclusion) BETWEEN 1 AND 2000),
  summaryRevision INTEGER NOT NULL CHECK(summaryRevision > 0),
  reviewedAt TEXT NOT NULL
);
CREATE INDEX ai_mcp_discovery_evidence_revision
  ON ai_mcp_discovery_evidence(summaryRevision);

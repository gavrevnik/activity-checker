CREATE TABLE ai_event_preference_summary (
  id TEXT PRIMARY KEY CHECK(id = 'main'),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 5000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updatedAt TEXT NOT NULL
);

INSERT INTO ai_event_preference_summary (id, summary, revision, updatedAt)
VALUES ('main', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- No entity FK: reviewed evidence must survive moving an event to the archive.
CREATE TABLE ai_event_preference_evidence (
  eventId TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  conclusion TEXT NOT NULL CHECK(length(conclusion) BETWEEN 1 AND 2000),
  summaryRevision INTEGER NOT NULL CHECK(summaryRevision > 0),
  reviewedAt TEXT NOT NULL
);

CREATE INDEX ai_event_preference_evidence_revision
  ON ai_event_preference_evidence(summaryRevision);

CREATE TABLE IF NOT EXISTS catalog_entity_links (
 local_entity_type TEXT NOT NULL, local_entity_id TEXT NOT NULL,
 radar_entity_type TEXT NOT NULL, radar_id TEXT NOT NULL,
 last_synced_revision TEXT NOT NULL, last_synced_at TEXT NOT NULL,
 canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
 local_json TEXT NOT NULL CHECK(json_valid(local_json)),
 PRIMARY KEY(local_entity_type,local_entity_id)
);
CREATE INDEX IF NOT EXISTS catalog_links_radar ON catalog_entity_links(radar_id);
CREATE TABLE IF NOT EXISTS catalog_records (
 radar_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL,
 revision TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS catalog_sync_state (
 id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL,
 data_revision TEXT NOT NULL, synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_outbox (
 id TEXT PRIMARY KEY, radar_id TEXT NOT NULL, entity_type TEXT NOT NULL,
 field TEXT NOT NULL, base_revision TEXT NOT NULL,
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 desired_json TEXT NOT NULL CHECK(json_valid(desired_json)),
 status TEXT NOT NULL CHECK(status IN ('pending','conflict','committed','discarded')),
 created_at TEXT NOT NULL, commit_sha TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS catalog_outbox_pending ON catalog_outbox(status,created_at);
CREATE TABLE IF NOT EXISTS catalog_sync_runs (
 id TEXT PRIMARY KEY, operation TEXT NOT NULL, revision TEXT,
 completed_at TEXT NOT NULL, details TEXT NOT NULL CHECK(json_valid(details))
);

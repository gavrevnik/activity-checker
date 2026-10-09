CREATE TABLE IF NOT EXISTS telegram_connector_requests (
 requestId TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision>=0),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_connector_gates (
 scope TEXT PRIMARY KEY,
 blockedUntil INTEGER NOT NULL
);

CREATE TABLE allevents_raw_events (
  sourceId TEXT NOT NULL REFERENCES sources(id),
  eventId TEXT NOT NULL,
  sourceItemId TEXT NOT NULL REFERENCES source_items(id),
  eventUrl TEXT NOT NULL DEFAULT '',
  startAt TEXT NOT NULL DEFAULT '',
  endAt TEXT NOT NULL DEFAULT '',
  categorySlugs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(categorySlugs)),
  rawPayload TEXT NOT NULL CHECK(json_valid(rawPayload)),
  rawChecksum TEXT NOT NULL,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  PRIMARY KEY(sourceId,eventId)
);
CREATE INDEX allevents_raw_start ON allevents_raw_events(sourceId,startAt);

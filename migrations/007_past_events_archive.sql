CREATE TABLE past_events_archive (
  entityId TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  startAt TEXT NOT NULL,
  endAt TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  archivedAt TEXT NOT NULL
);

CREATE INDEX past_events_archive_date
  ON past_events_archive(country, city, startAt);

-- Reviewed Telegram activities are deliberately separate from general entities.
CREATE TABLE telegram_events (
  id TEXT PRIMARY KEY,
  communityId TEXT NOT NULL REFERENCES entities(id),
  channelUsername TEXT NOT NULL,
  postId TEXT NOT NULL,
  activityKey TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  startAt TEXT NOT NULL,
  endAt TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL CHECK(json_valid(data)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(channelUsername, postId, activityKey)
);
CREATE INDEX telegram_events_scope_date ON telegram_events(country, city, startAt);
CREATE TABLE telegram_event_reviews (
  id TEXT PRIMARY KEY,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  createdAt TEXT NOT NULL
);

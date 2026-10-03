-- Human feedback is personal state, not source/AI content.
ALTER TABLE entities ADD COLUMN dislikeReason TEXT NOT NULL DEFAULT '';
ALTER TABLE telegram_events ADD COLUMN dislikeReason TEXT NOT NULL DEFAULT '';

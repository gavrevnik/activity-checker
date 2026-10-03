-- Personal ratings belong to the reviewed occurrence, not its channel or source post.
-- Separate columns preserve them when the same event is reviewed/imported again.
ALTER TABLE telegram_events ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1));
ALTER TABLE telegram_events ADD COLUMN reaction TEXT NOT NULL DEFAULT '' CHECK(reaction IN ('','like','dislike'));

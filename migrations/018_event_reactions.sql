ALTER TABLE entities ADD COLUMN reaction TEXT NOT NULL DEFAULT '' CHECK(reaction IN ('','like','dislike'));

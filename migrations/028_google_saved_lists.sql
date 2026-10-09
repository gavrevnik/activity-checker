CREATE TABLE google_saved_imports (id TEXT PRIMARY KEY, importedAt TEXT NOT NULL, kind TEXT NOT NULL, itemCount INTEGER NOT NULL, collectionCount INTEGER NOT NULL);
CREATE TABLE google_saved_items (id TEXT PRIMARY KEY, importId TEXT NOT NULL REFERENCES google_saved_imports(id), collection TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', comment TEXT NOT NULL DEFAULT '', placeId TEXT NOT NULL DEFAULT '', cid TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', latitude REAL, longitude REAL);
CREATE INDEX google_saved_place_id ON google_saved_items(placeId);
CREATE INDEX google_saved_cid ON google_saved_items(cid);

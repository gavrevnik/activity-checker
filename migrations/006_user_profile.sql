CREATE TABLE user_profile (
  id TEXT PRIMARY KEY CHECK(id = 'main'),
  data TEXT NOT NULL CHECK(json_valid(data)),
  updatedAt TEXT NOT NULL
);

CREATE TABLE source_item_heads (sourceId TEXT NOT NULL REFERENCES sources(id), externalId TEXT NOT NULL, sourceItemId TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE, normalizedChecksum TEXT NOT NULL DEFAULT '', PRIMARY KEY(sourceId,externalId));
INSERT INTO source_item_heads (sourceId,externalId,sourceItemId)
SELECT sourceId,externalId,id FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY sourceId,externalId ORDER BY fetchedAt DESC,id DESC) AS position FROM source_items) WHERE position=1;

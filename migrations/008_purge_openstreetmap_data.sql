DELETE FROM source_candidates
WHERE discoveredFrom IN (
  SELECT i.id
  FROM source_items i
  JOIN sources s ON s.id = i.sourceId
  WHERE s.providerId = 'overpass'
);

DELETE FROM entities
WHERE id IN (
  SELECT DISTINCT l.entityId
  FROM entity_source_links l
  JOIN source_items i ON i.id = l.sourceItemId
  JOIN sources s ON s.id = i.sourceId
  WHERE s.providerId = 'overpass'
)
AND NOT EXISTS (
  SELECT 1
  FROM entity_source_links other_link
  JOIN source_items other_item ON other_item.id = other_link.sourceItemId
  JOIN sources other_source ON other_source.id = other_item.sourceId
  WHERE other_link.entityId = entities.id
    AND other_source.providerId <> 'overpass'
);

DELETE FROM entity_source_links
WHERE sourceItemId IN (
  SELECT i.id
  FROM source_items i
  JOIN sources s ON s.id = i.sourceId
  WHERE s.providerId = 'overpass'
);

DELETE FROM source_item_heads
WHERE sourceId IN (SELECT id FROM sources WHERE providerId = 'overpass');

DELETE FROM source_items
WHERE sourceId IN (SELECT id FROM sources WHERE providerId = 'overpass');

UPDATE sources
SET enabled = 0,
    status = 'disabled',
    lastSyncAt = NULL,
    lastTestAt = NULL,
    lastAttemptAt = NULL,
    lastError = NULL,
    lastResult = NULL
WHERE providerId = 'overpass';

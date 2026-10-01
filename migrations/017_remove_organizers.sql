CREATE TEMP TABLE removed_organizer_items (
  id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO removed_organizer_items (id)
SELECT DISTINCT l.sourceItemId
FROM entity_source_links l
JOIN entities e ON e.id = l.entityId
WHERE e.type = 'Organizer';

DELETE FROM entities
WHERE type = 'Organizer';

DELETE FROM source_candidates
WHERE discoveredFrom IN (
  SELECT removed.id
  FROM removed_organizer_items removed
  WHERE NOT EXISTS (
    SELECT 1
    FROM entity_source_links l
    WHERE l.sourceItemId = removed.id
  )
);

DELETE FROM source_item_heads
WHERE sourceItemId IN (
  SELECT removed.id
  FROM removed_organizer_items removed
  WHERE NOT EXISTS (
    SELECT 1
    FROM entity_source_links l
    WHERE l.sourceItemId = removed.id
  )
);

DELETE FROM source_items
WHERE id IN (
  SELECT removed.id
  FROM removed_organizer_items removed
  WHERE NOT EXISTS (
    SELECT 1
    FROM entity_source_links l
    WHERE l.sourceItemId = removed.id
  )
);

DROP TABLE removed_organizer_items;

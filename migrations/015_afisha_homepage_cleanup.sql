CREATE TEMP TABLE afisha_homepage_items (
  id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO afisha_homepage_items (id)
SELECT i.id
FROM source_items i
JOIN sources s ON s.id = i.sourceId
WHERE s.providerId = 'afisha'
  AND json_extract(i.rawPayload, '$.normalized.rawCategory') = 'Event'
  AND json_extract(i.rawPayload, '$.original."@type"') IS NOT NULL
  AND json_extract(i.rawPayload, '$.original.section') IS NULL;

CREATE TEMP TABLE afisha_homepage_entities (
  id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO afisha_homepage_entities (id)
SELECT DISTINCT l.entityId
FROM entity_source_links l
JOIN afisha_homepage_items homepage ON homepage.id = l.sourceItemId;

DELETE FROM source_candidates
WHERE discoveredFrom IN (SELECT id FROM afisha_homepage_items);

DELETE FROM entity_source_links
WHERE sourceItemId IN (SELECT id FROM afisha_homepage_items);

DELETE FROM source_items
WHERE id IN (SELECT id FROM afisha_homepage_items);

DELETE FROM entities
WHERE id IN (SELECT id FROM afisha_homepage_entities)
  AND NOT EXISTS (
    SELECT 1
    FROM entity_source_links l
    WHERE l.entityId = entities.id
  );

DELETE FROM past_events_archive
WHERE EXISTS (
  SELECT 1
  FROM json_each(json_extract(snapshot, '$.provenance'))
  WHERE json_extract(value, '$.sourceId') = 'source-afisha'
    AND json_extract(value, '$.rawPayload.normalized.rawCategory') = 'Event'
    AND json_extract(value, '$.rawPayload.original."@type"') IS NOT NULL
    AND json_extract(value, '$.rawPayload.original.section') IS NULL
);

DROP TABLE afisha_homepage_entities;
DROP TABLE afisha_homepage_items;

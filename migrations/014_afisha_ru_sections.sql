UPDATE sources
SET url = 'https://afisha.rs/ru'
WHERE providerId = 'afisha';

CREATE TEMP TABLE afisha_excluded_items (
  id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO afisha_excluded_items (id)
SELECT DISTINCT i.id
FROM source_items i
JOIN sources s ON s.id = i.sourceId
LEFT JOIN entity_source_links l ON l.sourceItemId = i.id
LEFT JOIN entities e ON e.id = l.entityId
WHERE s.providerId = 'afisha'
  AND (
    json_extract(i.rawPayload, '$.original.section.slug') IN ('/ru/deti', '/ru/kino')
    OR json_extract(i.rawPayload, '$.normalized.rawCategory') IN ('Дети', 'Кино')
    OR i.sourceUrl LIKE 'https://afisha.rs/ru/deti/%'
    OR i.sourceUrl LIKE 'https://afisha.rs/ru/kino/%'
    OR EXISTS (
      SELECT 1
      FROM json_each(json_extract(e.data, '$.tags'))
      WHERE value IN ('Дети', 'Кино')
    )
  );

CREATE TEMP TABLE afisha_excluded_entities (
  id TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO afisha_excluded_entities (id)
SELECT DISTINCT l.entityId
FROM entity_source_links l
JOIN afisha_excluded_items excluded ON excluded.id = l.sourceItemId;

DELETE FROM source_candidates
WHERE discoveredFrom IN (SELECT id FROM afisha_excluded_items);

DELETE FROM entity_source_links
WHERE sourceItemId IN (SELECT id FROM afisha_excluded_items);

DELETE FROM source_items
WHERE id IN (SELECT id FROM afisha_excluded_items);

DELETE FROM entities
WHERE id IN (SELECT id FROM afisha_excluded_entities)
  AND NOT EXISTS (
    SELECT 1
    FROM entity_source_links l
    WHERE l.entityId = entities.id
  );

DELETE FROM past_events_archive
WHERE EXISTS (
    SELECT 1
    FROM json_each(json_extract(snapshot, '$.tags'))
    WHERE value IN ('Дети', 'Кино')
  )
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(snapshot, '$.sources'))
    WHERE json_extract(value, '$.providerId') = 'afisha'
  );

DROP TABLE afisha_excluded_entities;
DROP TABLE afisha_excluded_items;

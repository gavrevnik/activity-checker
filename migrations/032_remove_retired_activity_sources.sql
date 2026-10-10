-- Owner-requested retirement. Keep cards supported by other sources.
CREATE TEMP TABLE retired_sources AS
SELECT id FROM sources WHERE providerId IN ('bilet', 'overpass');
CREATE TEMP TABLE retired_items AS
SELECT id FROM source_items WHERE sourceId IN (SELECT id FROM retired_sources);
CREATE TEMP TABLE retired_entities AS
SELECT DISTINCT entityId AS id FROM entity_source_links
WHERE sourceItemId IN (SELECT id FROM retired_items)
AND NOT EXISTS (
  SELECT 1 FROM entity_source_links other
  WHERE other.entityId = entity_source_links.entityId
    AND other.sourceItemId NOT IN (SELECT id FROM retired_items)
);

-- Retired source candidates and runtime attempts must not block source deletion.
DELETE FROM source_candidates WHERE discoveredFrom IN (SELECT id FROM retired_items)
  OR lower(url) LIKE 'https://bilet.rs/%' OR lower(url) LIKE 'https://www.bilet.rs/%'
  OR lower(url) LIKE 'https://app.bilet.rs/%' OR lower(url) LIKE 'https://www.openstreetmap.org/%'
  OR lower(url) LIKE 'https://openstreetmap.org/%';
DELETE FROM catalog_entity_links WHERE
  (local_entity_type='sources' AND local_entity_id IN (SELECT id FROM retired_sources))
  OR (local_entity_type='entities' AND local_entity_id IN (SELECT id FROM retired_entities));
DELETE FROM ai_event_preference_evidence WHERE eventId IN (SELECT id FROM retired_entities);
DELETE FROM entity_source_links WHERE sourceItemId IN (SELECT id FROM retired_items);
DELETE FROM entities WHERE id IN (SELECT id FROM retired_entities);
DELETE FROM source_item_heads WHERE sourceId IN (SELECT id FROM retired_sources);
DELETE FROM source_items WHERE id IN (SELECT id FROM retired_items);
DELETE FROM sync_runs WHERE sourceId IN (SELECT id FROM retired_sources);

-- Archives carry their own provenance: remove only the retired entries, and
-- remove the whole snapshot only when no independent provenance remains.
CREATE TEMP TABLE retired_archives AS
SELECT entityId FROM past_events_archive a WHERE EXISTS (
  SELECT 1 FROM json_each(a.snapshot, '$.provenance') p
  WHERE json_extract(p.value, '$.sourceId') IN (SELECT id FROM retired_sources)
    OR json_extract(p.value, '$.providerId') IN ('bilet','overpass')
);
UPDATE past_events_archive SET snapshot=json_set(snapshot, '$.provenance', json((
  SELECT json_group_array(json(p.value)) FROM json_each(snapshot, '$.provenance') p
  WHERE coalesce(json_extract(p.value, '$.sourceId'),'') NOT IN (SELECT id FROM retired_sources)
    AND coalesce(json_extract(p.value, '$.providerId'),'') NOT IN ('bilet','overpass')
))) WHERE entityId IN (SELECT entityId FROM retired_archives);
DELETE FROM ai_event_preference_evidence WHERE eventId IN (
  SELECT entityId FROM past_events_archive WHERE entityId IN (SELECT entityId FROM retired_archives)
    AND json_array_length(snapshot, '$.provenance')=0
);
DELETE FROM past_events_archive WHERE entityId IN (SELECT entityId FROM retired_archives)
  AND json_array_length(snapshot, '$.provenance')=0;
DELETE FROM sources WHERE id IN (SELECT id FROM retired_sources);
DROP TABLE retired_archives;
DROP TABLE retired_entities;
DROP TABLE retired_items;
DROP TABLE retired_sources;

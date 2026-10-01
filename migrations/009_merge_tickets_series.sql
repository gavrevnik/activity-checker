CREATE TEMP TABLE tickets_series_merge (
  removeId TEXT PRIMARY KEY,
  keepId TEXT NOT NULL
);

WITH ticket_entities AS (
  SELECT DISTINCT
    e.id,
    e.startAt,
    json_remove(
      e.data,
      '$.startAt',
      '$.endAt',
      '$.url',
      '$.externalId',
      '$.knownIds',
      '$.aiScore',
      '$.aiDecision',
      '$.aiReason',
      '$.aiTags',
      '$.aiProcessedAt'
    ) AS content
  FROM entities e
  JOIN entity_source_links l ON l.entityId = e.id
  JOIN source_items i ON i.id = l.sourceItemId
  JOIN sources s ON s.id = i.sourceId
  WHERE s.providerId = 'tickets'
    AND e.type = 'Event'
    AND e.startAt <> ''
    AND json_extract(e.data, '$.demo') = 0
), ranked AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY content
      ORDER BY startAt, id
    ) AS keepId,
    ROW_NUMBER() OVER (
      PARTITION BY content
      ORDER BY startAt, id
    ) AS position,
    COUNT(*) OVER (PARTITION BY content) AS copies
  FROM ticket_entities
)
INSERT INTO tickets_series_merge (removeId, keepId)
SELECT id, keepId
FROM ranked
WHERE copies > 1 AND position > 1;

UPDATE entities
SET favorite = CASE
      WHEN EXISTS (
        SELECT 1
        FROM tickets_series_merge m
        JOIN entities removed ON removed.id = m.removeId
        WHERE m.keepId = entities.id AND removed.favorite = 1
      ) THEN 1
      ELSE favorite
    END,
    notes = trim(
      notes || CASE
        WHEN COALESCE((
          SELECT group_concat(removed.notes, char(10))
          FROM tickets_series_merge m
          JOIN entities removed ON removed.id = m.removeId
          WHERE m.keepId = entities.id AND removed.notes <> ''
        ), '') <> ''
        THEN char(10) || (
          SELECT group_concat(removed.notes, char(10))
          FROM tickets_series_merge m
          JOIN entities removed ON removed.id = m.removeId
          WHERE m.keepId = entities.id AND removed.notes <> ''
        )
        ELSE ''
      END,
      char(10) || char(13) || ' '
    )
WHERE id IN (SELECT keepId FROM tickets_series_merge);

INSERT OR IGNORE INTO entity_source_links (entityId, sourceItemId)
SELECT m.keepId, l.sourceItemId
FROM tickets_series_merge m
JOIN entity_source_links l ON l.entityId = m.removeId;

UPDATE source_candidates
SET entityId = (
  SELECT m.keepId
  FROM tickets_series_merge m
  WHERE m.removeId = source_candidates.entityId
)
WHERE entityId IN (SELECT removeId FROM tickets_series_merge);

INSERT OR IGNORE INTO entity_relations (fromId, toId, relation)
SELECT
  COALESCE(from_map.keepId, r.fromId),
  COALESCE(to_map.keepId, r.toId),
  r.relation
FROM entity_relations r
LEFT JOIN tickets_series_merge from_map ON from_map.removeId = r.fromId
LEFT JOIN tickets_series_merge to_map ON to_map.removeId = r.toId
WHERE (from_map.keepId IS NOT NULL OR to_map.keepId IS NOT NULL)
  AND COALESCE(from_map.keepId, r.fromId) <> COALESCE(to_map.keepId, r.toId);

INSERT OR IGNORE INTO duplicate_pairs (firstId, secondId, reason, status)
SELECT
  min(
    COALESCE(first_map.keepId, p.firstId),
    COALESCE(second_map.keepId, p.secondId)
  ),
  max(
    COALESCE(first_map.keepId, p.firstId),
    COALESCE(second_map.keepId, p.secondId)
  ),
  p.reason,
  p.status
FROM duplicate_pairs p
LEFT JOIN tickets_series_merge first_map ON first_map.removeId = p.firstId
LEFT JOIN tickets_series_merge second_map ON second_map.removeId = p.secondId
WHERE (first_map.keepId IS NOT NULL OR second_map.keepId IS NOT NULL)
  AND COALESCE(first_map.keepId, p.firstId) <>
      COALESCE(second_map.keepId, p.secondId);

DELETE FROM entities
WHERE id IN (SELECT removeId FROM tickets_series_merge);

DROP TABLE tickets_series_merge;

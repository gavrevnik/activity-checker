ALTER TABLE entities ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entities ADD COLUMN filterReason TEXT NOT NULL DEFAULT '[]';
CREATE INDEX entities_filtered ON entities(filtered, type, country, city);

ALTER TABLE sync_runs ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO settings(key, value) VALUES (
  'filtering-rules',
  '{"pastEvents":{"enabled":true},"telegramMinMembers":{"enabled":true,"minMembers":200},"ticketsVenue":{"enabled":true,"venue":"Pozorište Slavija"}}'
);

UPDATE entities
SET data = json_set(
  data,
  '$.memberCount',
  (
    SELECT MAX(CAST(json_extract(i.rawPayload, '$.original.channel.participantsCount') AS INTEGER))
    FROM entity_source_links l
    JOIN source_items i ON i.id = l.sourceItemId
    JOIN sources s ON s.id = i.sourceId
    WHERE l.entityId = entities.id
      AND s.providerId = 'telegram'
      AND json_extract(i.rawPayload, '$.original.channel.participantsCount') IS NOT NULL
  )
)
WHERE type = 'Community'
  AND EXISTS (
    SELECT 1
    FROM entity_source_links l
    JOIN source_items i ON i.id = l.sourceItemId
    JOIN sources s ON s.id = i.sourceId
    WHERE l.entityId = entities.id
      AND s.providerId = 'telegram'
      AND json_extract(i.rawPayload, '$.original.channel.participantsCount') IS NOT NULL
  );

UPDATE entities
SET data = json_set(
  data,
  '$.memberCount',
  (
    SELECT MAX(CAST(COALESCE(
      json_extract(i.rawPayload, '$.original.followersCount'),
      json_extract(i.rawPayload, '$.original.user.followersCount')
    ) AS INTEGER))
    FROM entity_source_links l
    JOIN source_items i ON i.id = l.sourceItemId
    JOIN sources s ON s.id = i.sourceId
    WHERE l.entityId = entities.id
      AND s.providerId = 'instagram'
      AND COALESCE(
        json_extract(i.rawPayload, '$.original.followersCount'),
        json_extract(i.rawPayload, '$.original.user.followersCount')
      ) IS NOT NULL
  )
)
WHERE type = 'Community'
  AND EXISTS (
    SELECT 1
    FROM entity_source_links l
    JOIN source_items i ON i.id = l.sourceItemId
    JOIN sources s ON s.id = i.sourceId
    WHERE l.entityId = entities.id
      AND s.providerId = 'instagram'
      AND COALESCE(
        json_extract(i.rawPayload, '$.original.followersCount'),
        json_extract(i.rawPayload, '$.original.user.followersCount')
      ) IS NOT NULL
  );

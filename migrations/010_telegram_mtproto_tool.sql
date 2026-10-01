UPDATE sources
SET name = 'Telegram MTProto · Discovery',
    enabled = 1,
    status = 'configured',
    lastError = NULL
WHERE id = 'source-telegram'
  AND providerId = 'telegram';

DELETE FROM entity_source_links
WHERE sourceItemId IN (
  SELECT i.id FROM source_items i
  JOIN sources s ON s.id = i.sourceId
  WHERE s.providerId = 'tgstat'
);

DELETE FROM source_item_heads
WHERE sourceId IN (SELECT id FROM sources WHERE providerId = 'tgstat');

DELETE FROM source_items
WHERE sourceId IN (SELECT id FROM sources WHERE providerId = 'tgstat');

DELETE FROM sync_runs
WHERE sourceId IN (SELECT id FROM sources WHERE providerId = 'tgstat');

DELETE FROM sources WHERE providerId = 'tgstat';

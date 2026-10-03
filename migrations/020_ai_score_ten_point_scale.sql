-- Every pre-migration score was on the 0–100 scale, including values <= 10.
UPDATE entities
SET data = json_set(data, '$.aiScore', json_extract(data, '$.aiScore') / 10.0)
WHERE json_type(data, '$.aiScore') IN ('integer', 'real');

UPDATE entities
SET overrides = json_set(overrides, '$.aiScore', json_extract(overrides, '$.aiScore') / 10.0)
WHERE json_type(overrides, '$.aiScore') IN ('integer', 'real');

UPDATE past_events_archive
SET snapshot = json_set(snapshot, '$.aiScore', json_extract(snapshot, '$.aiScore') / 10.0)
WHERE json_type(snapshot, '$.aiScore') IN ('integer', 'real');

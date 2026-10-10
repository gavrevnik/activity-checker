-- Explicit owner request: retain source exclusions and unrelated keywords.
UPDATE settings SET value=json_set(value,
  '$.excludeReplies', json('true'),
  '$.excludeAdDisclosures', json('true'),
  '$.minTextLength', max(51, coalesce(json_extract(value,'$.minTextLength'),51)),
  '$.excludeKeywords', json((SELECT json_group_array(value) FROM json_each(settings.value,'$.excludeKeywords')
    WHERE lower(value) NOT IN ('best-h@rdcore 18++ archive','where you can earn more than $5,000 three times daily')))
) WHERE key='telegram-monitoring-settings';

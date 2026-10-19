-- Correct the city landing URL from the initial local Moldova source rollout.
-- Preserve custom URLs and every source setting.
UPDATE sources SET url='https://afishamira.com/city/chisinau/'
WHERE id='source-afisha-mira' AND providerId='afisha-mira'
  AND scopeId='chisinau' AND url='https://afishamira.com/city/kishinyov/';

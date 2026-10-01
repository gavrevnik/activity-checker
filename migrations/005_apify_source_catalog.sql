UPDATE sources
SET name = 'Instagram Search · Apify'
WHERE id = 'source-instagram'
  AND providerId = 'instagram'
  AND name = 'Instagram · Apify';

UPDATE sources
SET name = 'Google Maps Places · Apify'
WHERE id = 'source-google-places'
  AND providerId = 'google-places'
  AND name = 'Google Places';

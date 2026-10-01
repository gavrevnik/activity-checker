# Local API

Base: `http://127.0.0.1:4318/api` internally and `http://activity-checker.localhost/api` through Life Hub/Caddy. JSON only for mutations. There is no CORS opt-in: Host is checked for every request, while Origin and `Sec-Fetch-Site` protect state-changing methods. Cross-site GET/HEAD navigation is allowed so Life Hub can open the app. All endpoints use local SQLite. `GET /bootstrap` returns scopes, provider metadata, sources (only credential presence), visible canonical entities, candidates, recent sync runs, the personal profile and filtering rules.

| Method | Path                              | Payload / response                                                               |
| ------ | --------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/health`                         | `{ ok, app }`                                                                    |
| GET    | `/bootstrap`                      | UI data                                                                          |
| GET    | `/profile`                        | Local personal search profile                                                    |
| PUT    | `/profile`                        | Full personal profile; replaces the saved value                                  |
| GET    | `/filter-rules`                   | Current static rules and hidden-card counts                                      |
| PUT    | `/filter-rules`                   | Full rules object; saves it and reapplies it to all entities                     |
| GET    | `/entities/:id`                   | Entity, provenance, relationships, possible duplicates                           |
| POST   | `/entities/archive-past`          | `{ scopeId }`; move completed dated events to `past_events_archive`              |
| POST   | `/entities`                       | Canonical input (type/title required)                                            |
| PUT    | `/entities/:id`                   | Full canonical input; changed fields become manual overrides                     |
| PATCH  | `/entities/:id`                   | `{ archived?, favorite?, notes? }`                                               |
| POST   | `/entities/:id/merge`             | `{ removeId }`, keeps `:id`                                                      |
| POST   | `/entities/:id/duplicates/ignore` | `{ otherId }`                                                                    |
| POST   | `/entities/:id/relations`         | `{ toId, relation, remove? }`; organizes/hosts/recommends/associated             |
| GET    | `/import/schema`                  | JSON Schema                                                                      |
| POST   | `/import/preview`                 | Import envelope/array or `{ text: "JSON" }`; no writes persist                   |
| POST   | `/import`                         | Same payload; atomic commit                                                      |
| POST   | `/sources`                        | SourceInput                                                                      |
| PUT    | `/sources/:id`                    | Full SourceInput; provider immutable                                             |
| POST   | `/sources/:id/test`               | `{}`; validates API/format, no entities saved                                    |
| POST   | `/sources/:id/sync-plan`          | Sync options → request/cost plan; AllEvents performs and caches an exact preview |
| POST   | `/sources/:id/sync`               | Sync options + `confirmed`; includes `filtered` alongside sync counters          |
| POST   | `/sync`                           | `{ scopeId: "belgrade" }`; sequential sync of eligible enabled sources           |
| POST   | `/candidates/:id`                 | `{ action: "accept" or "ignore" }`                                               |
| DELETE | `/demo`                           | `{}`; remove demo entities                                                       |
| GET    | `/export`                         | Canonical import envelope; not a complete database backup                        |

Example:

```sh
curl -s http://127.0.0.1:4318/api/import/preview \
  -H 'Content-Type: application/json' --data-binary @examples/import.json
curl -s http://127.0.0.1:4318/api/import \
  -H 'Content-Type: application/json' --data-binary @examples/import.json
```

SourceInput: `providerId`, `name`, `url`, `scopeId`, `enabled`, `language`, `audience`, `categories`, `priority` (0–100), `notes`, `format` (auto/json/jsonld/rss/ics), `keyword`, and provider-specific `minRating` (0–5 in 0.5 steps, default 4). Credentials are never accepted here. Unknown keys are rejected.

The personal profile is a strict object with general `summary` and arrays `eventPreferences`, `communityPreferences`, `musicPreferences`, and `artists`. The UI presents them as four sections; artists remain a collapsed list inside music. It contains no credentials and lives in the singleton `user_profile` SQLite row. Saving the profile does not start a sync or send data to an LLM.

Static filtering rules are a strict object with `pastEvents.enabled`, `telegramMinMembers.{enabled,minMembers}`, `ticketsVenue.{enabled,venues,keywords,titleKeywords}`, `eventTitle.{enabled,keywords}` and `eventLocation.{enabled,keywords}`. `ticketsVenue.venues` are exact Tickets.rs venue names, while `ticketsVenue.keywords` and `ticketsVenue.titleKeywords` use normalized substring matching against the Tickets.rs venue and event title respectively. The default Tickets-specific terms are venue keyword `pozorište` and title keyword `FEST 2026`. Global title and location rules apply to events from every source, with location covering both `venue` and `address`. Matching is case- and diacritic-insensitive. Filtering occurs after normalization and provenance storage. Matching entities remain in SQLite with `filtered=1` and are omitted from the normal list/export; changing a rule recomputes all rows. An unknown Telegram member count passes the minimum-size rule. Legacy stored settings with the former single `ticketsVenue.venue` value are upgraded in memory and retain a custom non-theatre venue; versioned defaults are merged once into already saved rules.

Event canonicalization also uses an aggressive duplicate rule: normalized title and city must match, followed by a matching calendar day, a missing date, or the same non-empty venue. Existing event pairs with `duplicate_pairs.status='new'` are forced through the same merge path. The earliest known `startAt` and its corresponding `endAt` win while provenance and user state are retained. The Activities UI additionally provides a non-destructive title filter for Serbian-specific Latin and Cyrillic letters; ASCII `J` is intentionally excluded.

Sync options are strict: `confirmed`, `startDate`, `endDate`, `categories`, `resultsPerQuery`, `maxItems`, optional Telegram `operations`, and optional `previewId`. AllEvents, paid Apify providers and Telegram MTProto reject direct sync without `confirmed=true`; clients should render `/sync-plan` first. An AllEvents plan returns an expiring `previewId`, exact page/request counts and cached cards; send that ID with the unchanged filters to `/sync`. Confirmation then performs no new AllEvents request. Apify tokens and Telegram credentials/session remain server-side; manual-only discovery sources are excluded from global `/sync`.

Expected validation/provider errors return `{ error }` with HTTP 400. Each remote sync has a persistent run record. Source secrets are redacted from error messages. A failed parse does not destroy the previous collection. Test reads a remote endpoint but never marks an unimplemented adapter as connected.

Provider metadata in `/bootstrap` also describes how Sources should present an integration: `configFields` is the audited allow-list of functional Configure fields (`scope`, `url`, `format`, `keyword`, `minRating`); `mcpServer` and `mcpTools` list model-callable STDIO tools; `webSearchLlm` marks setup-free indexed web discovery; `hiddenFromSources` suppresses legacy catalog rows; and `otherSource` moves low-priority regional integrations to the Other tab. The Google Places source additionally exposes a local `quotaUsage` snapshot for the current Pro billing month (`used`, `limit`, `remaining`, `billingMonth`). Credential values are never included; only per-key presence is returned.

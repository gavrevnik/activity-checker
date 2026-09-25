# Local API

Base: `http://127.0.0.1:4318/api`. JSON only for mutations. No CORS; Host/Origin checked. All endpoints use local SQLite. `GET /bootstrap` returns scopes, provider metadata, sources (only credential presence), canonical entities, candidates and recent sync runs.

| Method | Path                              | Payload / response                                                     |
| ------ | --------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/health`                         | `{ ok, app }`                                                          |
| GET    | `/bootstrap`                      | UI data                                                                |
| GET    | `/entities/:id`                   | Entity, provenance, relationships, possible duplicates                 |
| POST   | `/entities`                       | Canonical input (type/title required)                                  |
| PUT    | `/entities/:id`                   | Full canonical input; changed fields become manual overrides           |
| PATCH  | `/entities/:id`                   | `{ archived?, favorite?, notes? }`                                     |
| POST   | `/entities/:id/merge`             | `{ removeId }`, keeps `:id`                                            |
| POST   | `/entities/:id/duplicates/ignore` | `{ otherId }`                                                          |
| POST   | `/entities/:id/relations`         | `{ toId, relation, remove? }`; organizes/hosts/recommends/associated   |
| GET    | `/import/schema`                  | JSON Schema                                                            |
| POST   | `/import/preview`                 | Import envelope/array or `{ text: "JSON" }`; no writes persist         |
| POST   | `/import`                         | Same payload; atomic commit                                            |
| POST   | `/sources`                        | SourceInput                                                            |
| PUT    | `/sources/:id`                    | Full SourceInput; provider immutable                                   |
| POST   | `/sources/:id/test`               | `{}`; validates API/format, no entities saved                          |
| POST   | `/sources/:id/sync`               | `{}`; fetched/created/updated/duplicates/errors/warnings               |
| POST   | `/sync`                           | `{ scopeId: "belgrade" }`; sequential sync of eligible enabled sources |
| POST   | `/candidates/:id`                 | `{ action: "accept" or "ignore" }`                                     |
| DELETE | `/demo`                           | `{}`; remove demo entities                                             |
| GET    | `/export`                         | Canonical import envelope; not a complete database backup              |

Example:

```sh
curl -s http://127.0.0.1:4318/api/import/preview \
  -H 'Content-Type: application/json' --data-binary @examples/import.json
curl -s http://127.0.0.1:4318/api/import \
  -H 'Content-Type: application/json' --data-binary @examples/import.json
```

SourceInput: `providerId`, `name`, `url`, `scopeId`, `enabled`, `language`, `audience`, `categories`, `priority` (0–100), `notes`, `format` (auto/json/jsonld/rss/ics), `keyword`. Credentials are never accepted here. Unknown keys are rejected.

Expected validation/provider errors return `{ error }` with HTTP 400. Each remote sync has a persistent run record. Source secrets are redacted from error messages. A failed parse does not destroy the previous collection. Test reads a remote endpoint but never marks an unimplemented adapter as connected.

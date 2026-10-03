# Local API

## AI digests

`GET /api/ai-digests?scopeId=belgrade&archived=false` returns `{digests}`; use
`archived=true` for the archive. Country scopes include their city digests.
`GET /api/ai-digests/schema` returns the strict creation schema;
`POST /api/ai-digests` creates a standalone snapshot with client-generated UUID `id`,
`scopeId`, `title`, `requestSummary`, inclusive `startDate/endDate`, optional `notes`
and `items` (up to 100). Rows contain `title`, `description`, `startAt/endAt`,
`aiScore` (0–10), `sourceName`, HTTP(S) `sourceUrl`, optional HTTP(S) `eventUrl`,
optional `tags` (default `[]`, up to 12 tags of 1–50 letters/numbers with hyphen or
underscore separators, no `#`/spaces; lowercased and deduplicated).
Rows must overlap the requested period. Same ID/payload retries are idempotent;
changed payloads never overwrite an existing snapshot. `GET /api/ai-digests/:id`
returns the snapshot or 404. Historical digests start archived.
`PATCH /api/ai-digests/:id/tags {expectedItems, tags}` updates tags only: pass the
current full items array and one tag array per item, in matching order. Stale
items or mismatched counts are rejected (400), missing ID returns 404. Dates,
scores, descriptions and archival metadata are preserved. Read the updated
snapshot before subsequent retries or tagging; old creation payloads no longer
match after enrichment.
`POST /api/ai-digests/archive-past {scopeId}` archives when the entire digest period
is before the scope-local day, preserving rows and source links. General event
archive also returns `archivedDigests`; startup/sync respects auto-archive opt-out.
Read endpoints never archive. Storage: migration 027, `ai_digests` in existing SQLite.

Base: `http://127.0.0.1:4318/api` internally and `http://activity-checker.localhost/api` through Life Hub/Caddy. JSON only for mutations. There is no CORS opt-in: Host is checked for every request, while Origin and `Sec-Fetch-Site` protect state-changing methods. Cross-site GET/HEAD navigation is allowed so Life Hub can open the app. All endpoints use local SQLite. `GET /bootstrap` returns scopes, provider metadata, sources (only credential presence), visible canonical entities, candidates, recent sync runs, the personal profile and filtering rules.

| Method | Path                              | Payload / response                                                               |
| ------ | --------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/health`                         | `{ ok, app }`                                                                    |
| GET    | `/auto-archive/settings`          | `{ enabled: boolean }`; defaults to true                                          |
| PUT    | `/auto-archive/settings`          | Strict `{ enabled: boolean }`; persists without immediate archival                |
| GET    | `/bootstrap`                      | UI data                                                                          |
| GET    | `/profile`                        | Local personal search profile                                                    |
| PUT    | `/profile`                        | Full personal profile; replaces the saved value                                  |
| GET    | `/ai-events-review/context`       | `?scopeId=belgrade`; profile, summary, reviewed IDs, pending feedback (including archive), future unmarked candidates |
| PUT    | `/ai-events-review/summary`       | `{ expectedRevision, summary, evidence: [{eventId,fingerprint,conclusion}] }`; atomic summary + reviewed IDs |
| POST   | `/ai-events-review/scores`        | `?scopeId=belgrade`; `{ expectedSummaryRevision, scores: [{eventId,fingerprint,score,reason,tags?}] }`; atomic AI-only update |
| GET    | `/filter-rules`                   | Current static rules and hidden-card counts                                      |
| PUT    | `/filter-rules`                   | Full rules object; saves it and reapplies it to all entities                     |
| GET    | `/entities/:id`                   | Entity, provenance, relationships, possible duplicates                           |
| POST   | `/entities/archive-past`          | `{ scopeId }`; move completed dated events to `past_events_archive`              |
| POST   | `/entities`                       | Canonical input (type/title required)                                            |
| PUT    | `/entities/:id`                   | Full canonical input; changed fields become manual overrides                     |
| PATCH  | `/entities/:id`                   | `{ archived?, favorite?, reaction?, notes?, dislikeReason?, skipped?, skipReason? }`; реакция события: `like`, `dislike` или `""` |
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

Entity responses include a server-prepared `presentation` object (local date labels/days/hour, searchable text and static display flags). It is a derived SQLite cache, not canonical import/export input. `PATCH /entities/:id` returns the compact Entity, including source badges and duplicate count, without provenance, relationships or duplicate details; use `GET /entities/:id` for those. PATCH updates only supplied personal-state fields and does not read the entire catalogue.

Example:

```sh
curl -s http://127.0.0.1:4318/api/import/preview \
  -H 'Content-Type: application/json' --data-binary @examples/import.json
curl -s http://127.0.0.1:4318/api/import \
  -H 'Content-Type: application/json' --data-binary @examples/import.json
```

SourceInput: `providerId`, `name`, `url`, `scopeId`, `enabled`, `language`, `audience`, `categories`, `priority` (0–100), `notes`, `format` (auto/json/jsonld/rss/ics), `keyword`, and provider-specific `minRating` (0–5 in 0.5 steps, default 4). Credentials are never accepted here. Unknown keys are rejected.

The personal profile is a strict object with general `summary` and arrays `eventPreferences`, `communityPreferences`, `musicPreferences`, and `artists`. The UI presents them as four sections; artists remain a collapsed list inside music. It contains no credentials and lives in the singleton `user_profile` SQLite row. Saving the profile does not start a sync or send data to an LLM.

AI scores use the 0–10 scale (`null` means no AI score); higher is more relevant. Migration 020 converts every existing numeric score from the previous 0–100 scale by dividing by ten, including overrides and archived snapshots. Canonical imports now reject values above 10.

The AI event review workflow starts with the normal `/entities/archive-past` operation, then reads `/ai-events-review/context`. Human-unmarked candidates are visible, non-demo, non-archived `Event` rows with no reaction or favorite, and a known `startAt >= now`. Date-only starts use today's local calendar day in the scope timezone. Previously scored but human-unmarked cards remain candidates. Feedback is global across scopes and includes filtered/archived cards. `pendingFeedback` contains new positive/negative signals and changes to previously incorporated reaction snapshots, including cleared signals and edited/cleared `dislikeReason`. Telegram occurrence feedback is included with `origin=telegram_events` and namespaced evidence IDs `telegram:<id>` (including expired events); Telegram events remain separate from canonical score candidates. AI fields are excluded from feedback fingerprints. Empty reasons are omitted from snapshots to preserve existing reviewed fingerprints.

Migration 024 stores `dislikeReason` separately from source content and notes in both entity tables. The personal-state PATCH endpoints accept a trimmed string up to 2000 characters; `""` clears it. Writes preserve ratings/favorites unless explicitly provided. Sync, reimport and archival preserve the reason. A stored reason with a cleared dislike or a like is historical, not a current negative signal; the skill interprets it only with an active dislike. No LLM call is made when saving feedback.

Migration 026 adds `skipped` (boolean, default false) and `skipReason` (trimmed string, maximum 2000 characters) to both event tables. `PATCH /entities/:id` and `PATCH /telegram-events/:id` accept `{ "skipped": true, "skipReason": "дубль" }`; a skip clears the reaction, while a like/dislike clears skipped. Favorites remain independent. `{ "skipped": false }` undoes the skip without inventing a reaction. Skipped cards are excluded from Unrated and score candidates, but available through the Skipped evaluation filter. Skip reasons and flags are never preference feedback or recommendation evidence; clearing an incorporated reaction only withdraws the old signal. Sync/reimport/archive preserve them. Reasons are distinct from `dislikeReason`. UI feedback is optional and retains the card until submission or an outside action.

`ai_event_preference_summary` holds the singleton compact text (up to 5000 characters), revision and update time. `ai_event_preference_evidence` holds each reviewed event ID, its feedback fingerprint/snapshot, conclusion (up to 2000 characters), summary revision and review time. Evidence survives archiving without an active-entity FK. Summary writes require the current `expectedRevision` and 1–500 distinct pending IDs with matching fingerprints. The API records the agent's conclusions; it does not infer taste automatically. Changed/cleared reactions overwrite the previous per-ID conclusion and require the agent to revise the overall summary.

Score writes accept 1–100 distinct candidates with matching fingerprints and `expectedSummaryRevision`; any unprocessed feedback blocks scoring. Candidate fingerprints also reflect the personal profile, so a concurrent profile/card change rejects stale scores. Each batch is atomic. The API changes only `aiScore`, `aiReason`, `aiTags`, `aiProcessedAt`, and `aiDecision` (`recommended` for scores >= 7, otherwise `unknown`), preserving human state and source data. Re-read context after each batch or conflict. Standard review skips undated, past or human-marked cards; explicit user exceptions can use the general canonical edit endpoint. Skill instructions and payload examples live in `skills/ai-events-review/`.

Static filtering rules are a strict object with `pastEvents.enabled`, `telegramMinMembers.{enabled,minMembers}`, `ticketsVenue.{enabled,venues,keywords,titleKeywords}`, `eventTitle.{enabled,keywords}` and `eventLocation.{enabled,keywords}`. `ticketsVenue.venues` are exact Tickets.rs venue names, while `ticketsVenue.keywords` and `ticketsVenue.titleKeywords` use normalized substring matching against the Tickets.rs venue and event title respectively. The default Tickets-specific terms are venue keyword `pozorište` and title keyword `FEST 2026`. Global title and location rules apply to events from every source, with location covering both `venue` and `address`. Matching is case- and diacritic-insensitive. Filtering occurs after normalization and provenance storage. Matching entities remain in SQLite with `filtered=1` and are omitted from the normal list/export; changing a rule recomputes all rows. An unknown Telegram member count passes the minimum-size rule. Legacy stored settings with the former single `ticketsVenue.venue` value are upgraded in memory and retain a custom non-theatre venue; versioned defaults are merged once into already saved rules.

Event canonicalization also uses an aggressive duplicate rule: normalized title and city must match, followed by a matching calendar day, a missing date, or the same non-empty venue. Existing event pairs with `duplicate_pairs.status='new'` are forced through the same merge path. The earliest known `startAt` and its corresponding `endAt` win while provenance and user state are retained. The Activities UI additionally provides a non-destructive title filter for Serbian-specific Latin and Cyrillic letters; ASCII `J` is intentionally excluded.

Sync options are strict: `confirmed`, `startDate`, `endDate`, `categories`, `resultsPerQuery`, `maxItems`, optional Telegram `operations`, and optional `previewId`. AllEvents, paid Apify providers and Telegram MTProto reject direct sync without `confirmed=true`; clients should render `/sync-plan` first. An AllEvents plan returns an expiring `previewId`, exact page/request counts and cached cards; send that ID with the unchanged filters to `/sync`. Confirmation then performs no new AllEvents request. Apify tokens and Telegram credentials/session remain server-side; manual-only discovery sources are excluded from global `/sync`.

Expected validation/provider errors return `{ error }` with HTTP 400. Each remote sync has a persistent run record. Source secrets are redacted from error messages. A failed parse does not destroy the previous collection. Test reads a remote endpoint but never marks an unimplemented adapter as connected.

### Profile-guided MCP discovery memory

- `GET /api/ai-mcp-discovery/context?scopeId=belgrade&limit=200` returns fresh profile,
  shared `preferenceSummary`, `reviewedFeedback` and `pendingFeedback`, plus independent
  `querySummary`, `reviewedQueries`, `pendingQueries`, full `pendingQueryCount`,
  `queryCount`, grouped `keywordStats` and current local Google Places per-SKU quotas.
  Limit is 1–500 and paginates pending work by repeatedly saving and re-reading.
  Reads make no external API calls or quota reservations.
- `POST /api/ai-mcp-discovery/queries` accepts strict `{queries:[{queryId,snapshot}]}`,
  1–100 receipts. Snapshot describes provider/operation/query/scope/run/time, outcome,
  nullable returned/relevant/stored/request counts and cost, flat parameters and notes.
  Stable IDs allow retry or metric corrections, but cannot be reused for a different
  query identity. Batch writes are atomic; plans are not completed-query receipts.
- `PUT /api/ai-mcp-discovery/summary` accepts strict
  `{expectedRevision,summary,evidence:[{queryId,fingerprint,conclusion}]}`.
  Text is limited to 5000 characters; each conclusion to 2000; 1–500 distinct current
  pending IDs are required. Stale revision/fingerprint or duplicate IDs reject the
  entire batch. Re-read and reconsider before retrying.

Migration 025 creates `ai_mcp_discovery_summary`, `ai_mcp_discovery_evidence` and
`ai_mcp_discovery_query_history`. Existing Telegram query receipts are read in place
as `telegram:<id>`, completed Google usage as `google-places:<id>`, manual receipts
as `recorded:<id>`. Google reservations are excluded until completed. Updated
Telegram relevance marking or corrected manual metrics re-enter pending. Unknown
relevance/metrics remain null, not evidence of zero yield; failed calls are not
treated as irrelevant results. Per-provider/operation/scope/parameter statistics
keep assessed denominators separate from unassessed output. Old Telegram history
lacks scope and reliable truncation metadata; do not infer them.

The preference summary is shared with AI-review, including changed feedback reasons
and Telegram occurrence reactions; discovery does not create another taste memory,
archive events, run a search, or generate an LLM summary itself. An external model
uses `skills/ai-mcp-discovery/` before planning and after each completed batch,
including user-requested LLM sync/filtering of Tickets.rs and other aggregators.
Quota-limited/paid searches require a current per-run spending allowance after
showing known total/used/remaining limits; local Google counters exclude outside
traffic, and unavailable Apify account balance is reported as unknown. This is a
skill authorization gate, not a new universal billing enforcement layer.
Payload examples live in `skills/ai-mcp-discovery/references/api.md`.

### Separate Telegram events

- `GET /api/telegram-events?scopeId=belgrade` returns `{events,review}` from separate tables, with channel tags, post title (first line), at most five preview sentences, full source text and post URL. Past occurrences are hidden without deletion. Country/city scope applies to events.
- `GET /api/telegram-events/count?scopeId=belgrade` returns `{count}` for the same non-expired, geographically scoped events, independent of the UI's search/channel/score filters.
- `GET /api/telegram-monitoring/settings` returns `{settings,channels}`. Settings are `{excludeKeywords,excludedChannels,excludeReplies,excludeAdDisclosures}`; channels include filtered and monitoring-disabled communities, not archived ones. This lookup makes no Telegram requests.
- `PUT /api/telegram-monitoring/settings` validates and persists the complete strict settings object, returning `{settings}`. Keywords are case-insensitive literal text substrings, one term per UI line. Channel usernames are canonicalized from usernames/@usernames/t.me URLs. Saved channel exclusions are enforced before any RPC for all MCP selection modes and hide existing events from the current feed/count/review channels, as does archiving a community. Stored events, personal state and historical reviews are retained; re-enabling/unarchiving restores future events. Saved keyword/reply/ad rules are passed to the worker before returned posts can reach an LLM and do not retroactively hide existing events. Per-call rules may add exclusions, not bypass saved ones.
- `GET /api/telegram-events/review-context` returns the current profile and its fingerprint.
- `GET /api/telegram-events/:id` returns one reviewed event including independent `favorite: boolean` and `reaction: "" | "like" | "dislike"`; ID lookup also works for expired events to confirm interrupted writes.
- `PATCH /api/telegram-events/:id` accepts a strict non-empty `{favorite?,reaction?,dislikeReason?,skipped?,skipReason?}` personal-state assignment. It changes neither source content nor channel/general Event state. These idempotent assignments can be retried safely and are preserved on reimport. Dislike and skip do not delete the event. UI defaults to Unrated (no reaction, favorite or skip), with rating/favorite/skip filters available. Responses and ID lookups include both reasons and the skip flag.
- `POST /api/telegram-events/review` explicitly writes a reviewed monitoring snapshot: `{startDate,endDate,expectedProfileFingerprint,monitoring,selections,channelReviews}`. Each selection references `communityId`, `postId`, stable `activityKey` and provides title, verified future date/time, location, relevance score 1–10, relevance reason and validation notes. Replies, explicit ads, missing/empty source posts, out-of-window publications, duplicate keys and a stale profile are rejected before an atomic write. Reimporting the same channel/post/activity key updates its card. Nothing is imported into general Event entities.

Monitoring MCP defaults exclude replies and explicit advertising disclosures. `replyCount` is metadata about replies to a source post, not a reason to discard that post. Keyword, hashtag and domain exclusions remain optional literal rules; they do not infer that every paid event is an ad.

Provider metadata in `/bootstrap` also describes how Sources should present an integration: `configFields` is the audited allow-list of functional Configure fields (`scope`, `url`, `format`, `keyword`, `minRating`); `mcpServer` and `mcpTools` list model-callable STDIO tools; `webSearchLlm` marks setup-free indexed web discovery; `hiddenFromSources` suppresses legacy catalog rows; and `otherSource` moves low-priority regional integrations to the Other tab. The Google Places source additionally exposes a local `quotaUsage` snapshot for the current Pro billing month (`used`, `limit`, `remaining`, `billingMonth`). Credential values are never included; only per-key presence is returned.

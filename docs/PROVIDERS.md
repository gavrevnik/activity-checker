# Provider reference

The UI is the operational setup guide. Every adapter supplies credential names, ordered steps, docs, limitations and connection status. Metadata is serializable; methods and credentials never go to the client. The recommended catalog is seeded once per provider ID; user settings are retained.

## Adapter example

```ts
import { defineProvider } from "./types.js";
import { fetchJson } from "./http.js";

export const provider = defineProvider(
  {
    id: "my-calendar",
    name: "My Calendar",
    group: "Свои источники",
    providerType: "API",
    mode: "ingestion",
    implemented: true,
    supportedEntityTypes: ["Event"],
    supportedScopes: ["*"],
    description: "Events from a specific public calendar.",
    credentials: [],
    docs: [],
    steps: ["Add a calendar URL."],
    limitations: "One calendar per source.",
  },
  {
    async testConnection(ctx) {
      const data = await fetchJson(ctx.source.url);
      if (!Array.isArray(data.events)) throw new Error("Missing events array");
      return "Calendar is readable";
    },
    async sync(ctx) {
      const data = await fetchJson(ctx.source.url);
      return {
        items: data.events.map((event: any) => ({
          externalId: String(event.id),
          url: event.url,
          rawText: event.description || "",
          payload: event,
        })),
      };
    },
    normalize(item, ctx) {
      const data = item.payload as any;
      return {
        type: "Event",
        title: data.title,
        url: item.url,
        country: ctx.scope.country,
        city: ctx.scope.city || "",
        startAt: data.startsAt,
        description: item.rawText,
      };
    },
  },
);
```

Add the module to `registry.ts`. Add credentials to `secrets.ts` and `.env.example` if needed. Use global external IDs only when the provider guarantees their uniqueness; generic feeds are namespaced to the Source. Reuse `fetchText/fetchJson`: timeout, response-size limit, status handling, redirect checks, rejection of local/reserved addresses. No browser scraping or automatic retry of billed calls.

Keep raw items intact. `normalize` returns input for the common Zod schema; store handles deduplication, overrides, versions, links and discovery. `null` means intentionally skipped item. Fatal request/format failures throw; `warnings` describe partial coverage. Never turn network/parse failures into a fake successful empty list.

## Credentials and remaining steps

| Provider            | Variables                              | Setup / behavior                                                                                                                                                                                                |
| ------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overpass            | Optional `OVERPASS_URL`                | [Docs](https://wiki.openstreetmap.org/wiki/Overpass_API); works without key and appears under Other                                                                                                             |
| Ticketmaster        | `TICKETMASTER_API_KEY`                 | [Create app](https://developer.ticketmaster.com/products-and-docs/tutorials/events-search/search_events_with_discovery_api.html); implemented, but moved to Other because Belgrade/Serbia coverage can be empty |
| Telegram MTProto    | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Implemented Telethon worker, manual UI discovery, CLI and STDIO MCP; run `npm run telegram:setup`, then `npm run telegram:auth` once. Session is stored outside the repository and SQLite.                      |
| Instagram / Apify   | `APIFY_TOKEN`                          | [Search Actor](https://apify.com/apify/instagram-search-scraper); implemented batch discovery through UI, CLI and MCP; paid runs require explicit confirmation                                                  |
| Facebook / Apify    | `APIFY_TOKEN`                          | [Actor](https://apify.com/apify/facebook-events-scraper); implemented batch event discovery through UI and MCP; fixture-backed normalization tests                                                              |
| Meetup              | None                                   | LLM Web only: search indexed public pages on [Meetup](https://www.meetup.com/); no local API setup                                                                                                              |
| Eventbrite          | None                                   | LLM Web only: search indexed public pages on [Eventbrite](https://www.eventbrite.com/); no local API setup                                                                                                      |
| Belgrade Beat       | None                                   | Implemented weekly HTML adapter plus a separate LLM Web card for additional public-site research; no local API setup                                                                                            |
| Google Maps / Apify | `APIFY_TOKEN`                          | [Actor](https://apify.com/compass/crawler-google-places); implemented batch place discovery through UI and MCP; reviews/images enrichment disabled                                                              |
| Google Places (New) | `GOOGLE_PLACES_API_KEY`                | Official Text Search MCP; unlimited IDs-only discovery, Pro/Enterprise field masks, SQLite monthly counters and hard stops                                                                                      |
| Foursquare          | `FOURSQUARE_API_KEY`                   | Current Places Search API, UI and MCP keyword discovery; local 500-request monthly hard stop prevents paid overflow                                                                                             |

The user must obtain their own access and check the current conditions with the provider. Planned adapters explicitly return `setup_required` even if every variable is present. TGStat is absent from the source catalog. PredictHQ and the removed Facebook/ScrapeCreators definition are retained only as hidden legacy metadata so old SQLite rows remain readable; neither appears in Sources. Newly discovered Facebook URLs use `facebook-apify`.

## Telegram MTProto worker and tools

`workers/telegram_mtproto.py` is a JSON/stdio Telethon boundary. The web process passes API credentials only to the local child process. Initial phone/code/2FA authorization is available only through `npm run telegram:auth`; the HTTP API and MCP tools cannot accept those secrets. The default session location is `../data/activity-checker/telegram/activity-checker.session` with restrictive permissions.

Discovery supports only `searchPublicChats` (implemented with `contacts.search`) and `channels.getChannelRecommendations`. It accepts up to 30 keyword hypotheses, opens one authorized client, executes RPCs sequentially, waits 2.5–3.25 seconds between calls, deduplicates by public channel ID, filters out private chats/users, and enforces per-query and global hard caps. Optional `minParticipants` drops only channels with a known smaller audience; unknown counts pass. `FloodWait` stops the batch and reports the required delay. The former `channels.searchPosts` and `messages.searchGlobal` implementations remain dormant in the worker but are absent from accepted operations, MCP registration and UI options.

`npm run telegram:tool` is dry-run by default and requires `--execute` for an external discovery search. `--store` additionally ingests results into SQLite. `npm run telegram:discovery:mcp` exposes the same executor over stdio; `npm run telegram:mcp` remains its compatibility alias. MCP persistence is opt-in with `store=true`; otherwise the LLM receives search results without mutating the entity/source tables.

The separate `npm run telegram:monitoring:mcp` server exposes a read-only stored-channel list and paginated `messages.getHistory` retrieval. Date-only bounds are inclusive in the requested IANA timezone. Incremental runs use per-channel `afterMessageIds`; older-page continuation uses `beforeMessageIds`. Batches accept at most 20 channels and run RPCs sequentially with a 4 second base delay plus 0–1.5 seconds jitter. Page size defaults to 100 to minimize RPC count. A `FloodWait` aborts immediately with its retry interval rather than being slept through.

Monitoring returns message text and timestamps plus entity spans, hashtags, mentions, links, inline buttons, media type/metadata, author/sender and reply/forward/grouped IDs, views, forwards, replies, reactions, restrictions and simple deterministic signals. Pre-LLM filters support views/text length, forwarded/reply/media-only messages, explicit ad disclosures, literal keywords, hashtags, link domains and media types. Explicit disclosures can be removed deterministically; unmarked native advertising cannot be classified reliably without channel-specific rules or semantic review. Monitoring does not write post content to SQLite.

Every executed discovery records one `telegram_query_history` row per operation/query or recommendation seed, including the audience cutoff and returned count. `telegram_mark_query_relevance` adds manually reviewed relevant/stored counts, and `telegram_query_history` reads them back for later search-plan optimization. `npm run telegram:research` batches a larger profile pool while preserving the 30-query worker limit.

Discovery channel results normalize to `Community` with structured `memberCount`. Legacy stored public-message rows remain parse-compatible, but active discovery no longer creates post-shaped Event candidates. Monitoring returns posts for downstream analysis without treating publication time as an event date.

## Apify batch executor

`instagram`, `facebook-apify`, and `google-places` are real discovery adapters backed by one shared executor. The source `keyword` field contains up to 30 newline-separated search hypotheses. A sync performs exactly one Actor run for that provider:

```text
LLM / user → SearchPlan (up to 30 hypotheses)
           → one Instagram Actor run
           → one Facebook Actor run
           → one Google Maps Actor run
```

Provider input is batched natively: Instagram receives one comma-separated `search`, Facebook receives one `searchQueries` array, and Google Maps receives one `searchStringsArray`. `resultsPerQuery` controls the provider input and `maxItems` is a separate global charged-result hard cap. The synchronous dataset endpoint also receives `maxTotalChargeUsd`. There are no automatic retries of paid Actor runs.

Planning estimates used by the app are Instagram Search ≈ **$0.0027/result**, Google Maps ≈ **$0.004/place**, and Facebook Events ≈ **$0.013/event**. These are budget estimates, not a contractual price; the Actor page is authoritative. Facebook is therefore reserved for narrower, high-value plans. The UI shows the maximum estimate and requires explicit confirmation. All three providers have `manualSyncOnly=true`, so global Sync cannot spend Apify budget.

`npm run apify:tool` exposes the same executor for agent/terminal discovery. It is dry-run by default. `--execute` is explicit; `--test-live` clamps both provider input and dataset `maxItems` to at most two results. `npm run apify:mcp` publishes `apify_status`, `apify_instagram_search`, `apify_facebook_events_search`, and `apify_google_places_search`; MCP search also defaults to a no-cost plan and needs `execute=true` before starting an Actor. Unit tests use mocked HTTP and never bill Apify. The free connection test calls `/v2/users/me` and never starts an Actor.

Raw Actor rows are retained under `source_items.rawPayload.original`; normalized Community/Event/Place data is stored alongside it. Instagram Search creates Community records, Facebook creates Event records, and Google Maps creates Place records.

## Google Places API (New) MCP

The official `google-places-api` provider is separate from the retained Apify `google-places` provider. `npm run google-places:mcp` exposes status, IDs-only, Pro, Enterprise and the default two-pass discovery flow. The API key is read only from `GOOGLE_PLACES_API_KEY`.

IDs-only uses the exact mask `places.id,places.name,nextPageToken`. Pro requests the stable fields needed by a local Place card in one call, including `displayName`, `formattedAddress`, `location`, types and `googleMapsUri`; it deliberately excludes `rating` and `userRatingCount`, because those fields promote Text Search to Enterprise. Enterprise includes the same stable Pro fields plus Enterprise fields, is isolated in its own tool, and requires explicit `confirmEnterprise=true` in addition to `execute=true`.

The default batch executes one IDs-only call per hypothesis, records IDs in `google_places_discovered_ids`, checks canonical `entity_keys`, and repeats only productive hypotheses in Pro. Pro rows without both a display name and valid coordinates are rejected. `minRating` defaults to 4, is configurable per Source, and is sent in every search request. Accepted Pro results automatically create or update canonical Place cards containing display name, `googleMapsUri`, address, coordinates and types. `knownIds.google_place` deduplicates official and Apify records.

Pro results do not contain `rating` or `userRatingCount`. A deliberately confirmed Enterprise search persists those returned fields as `googleRating`, `googleReviewCount`, `googleRatingSource` and `googleRatingCheckedAt`; the raw provider snapshot remains compact. `google_places_store_llm_ratings` can still save independently verified values without an external API request or quota usage, and later Pro ingestion does not overwrite either enrichment.

Every dispatched request is conservatively reserved in `google_places_api_usage` before network I/O. Billing months follow Google’s reset at midnight Pacific Time on the first day of the month. Local hard limits are 5,000 Pro and 1,000 Enterprise requests per month; IDs-only is recorded but unlimited. SKU limits remain independent, matching Google billing. Weight units (`0/1/5`) are stored only as a comparative Pro-equivalent metric. Calls made outside Activity Checker are invisible locally, so operators must also configure Google Cloud quotas.

## Foursquare MCP and quota

`foursquare` uses `GET https://places-api.foursquare.com/places/search` with service-key Bearer authentication and `X-Places-Api-Version: 2025-06-17`. The same adapter powers confirmed UI sync and `npm run foursquare:mcp`. `foursquare_status` reads credentials and the local counter without calling Foursquare; `foursquare_search_places` is dry-run by default, accepts at most 10 hypotheses, and requires `execute=true` for live lookup. `store=true` is a separate opt-in for SQLite ingestion.

Foursquare allows 500 free Pro API calls per calendar month before the next pricing tier. Each hypothesis maps to one call. `.runtime/foursquare-quota.json` tracks local usage with a lock and atomic rename; the 501st call is rejected. A missing counter starts the current month at zero, while a corrupt/unreadable counter fails closed. The implementation does not support bypassing the limit or automatically entering the paid tier. Project price assumptions live in `data/provider-quotas.json` alongside Apify estimates.

## AllEvents

The `allevents` adapter accepts only `https://allevents.in/belgrade/all` and only the Belgrade scope. It is manual-only and requires the sync-plan confirmation endpoint. Unlike other plans, this endpoint performs the remote preview needed for an exact page count: one HTML request followed by continuation pages until the last short page. AllEvents exposes no total in the HTML response. The resulting cards and `previewId` are cached in server memory for 10 minutes; confirmed sync consumes that preview with zero additional AllEvents requests.

When the selected dates/categories match the HTML response, its embedded first page is parsed and reused. Custom filters use an API first page instead. Changing filters invalidates the client preview and requires an explicit recalculation. The plan carries inclusive start/end dates, category slugs, exact data-page/request counts, and a 20-page ceiling. Requests are separated by randomized 2–3 second pauses. Hitting the ceiling without detecting the final page is an error rather than an inaccurate plan.

Three consecutive 401/403/429/503 responses for a request abort the preview. The error is persisted on the source and shown in the modal; no `sync_runs` row is created before the user confirms database ingestion. No proxy rotation, CAPTCHA solving, header impersonation, or automatic retry is attempted.

Each original card is versioned in `source_items` and upserted into the dedicated `allevents_raw_events` current-snapshot table before canonical display. Duplicate page rows are collapsed by AllEvents `event_id`; canonical Event ingestion also matches exact title + instant + city when a second source omits a venue. Supported data includes title/description/organizer, start/end, categories/tags/formats, venue/address/coordinates, event and ticket URLs, image, and stable ID. The interface is undocumented and can change; the operator must check AllEvents terms and obtain permission when required.

Tickets.rs has a dedicated adapter in `websites/tickets.ts`. It reads the website's public application configuration and calls the same read-only JSON endpoints as its search page (`web__Get_PageConfig`, `web__Get_SearchMenu`, `web__Get_EventList`). No account or user API key is required; public application parameters are fetched per run and are never stored in raw records. This is an undocumented website interface, not a partner API.

Setup: use `https://tickets.rs/` and either the row-level run icon or the **Запустить** button in the API Aggregators heading. The adapter resolves the search widget and city IDs dynamically, checks the server's selected city filter, and loads current/future events with pagination (up to 60 pages across Belgrade and its separately listed districts, including Zemun). The source keyword maps to search text. Serbia-wide import is not yet supported because list records do not include city/country and the catalog also includes foreign cities; the adapter must not label all results as Serbian.

Event IDs deduplicate repeated listings. In addition, Tickets.rs date series are collapsed when all canonical content matches except `startAt`, `endAt`, URL and technical IDs. Exact but different performance times do not split such a series: the lowest current `startAt` wins, so 12:00 is retained over 17:00. Venue, description, price, image and other content remain part of the fingerprint. A persistent provider identity lets the same canonical card advance to the next available showing on a later sync. Migration `009_merge_tickets_series.sql` applies the same rule to existing data while rehoming provenance and preserving favorites/notes. Raw event fields and the town filter are preserved. Dates use Europe/Belgrade, with time only when supplied. Zero prices remain unknown, and undated vouchers are skipped with a warning. Categories/full descriptions are not available in list responses. Partial parsing and page limits produce warnings; changed configuration, ignored city filters, failed requests or broken pagination produce errors rather than false successful empty imports. Test checks parsing of the first city page; Sync loads the complete bounded selection.

The post-normalization Tickets.rs rule supports exact venue exclusions plus separate normalized keyword lists for venue and title. Its defaults exclude theatre venues via `pozorište` and event titles containing `FEST 2026`; the latter remains source-specific and does not hide identically named cards from other providers.

`ProviderInfo.registration` identifies the actual account service and its URL. Source rows render a compact registration badge only while that connection is not operational; a green operational check replaces it after a successful connection or when a credential-complete MCP is available. It is absent for public sources, LLM Web and manual import. `setupMessage` explains any disabled integration without suggesting that credentials alone would fix it.

`ProviderInfo.modelCallable` is an explicit capability flag for providers exposed as a local model tool. Source rows show a green operational check for a `connected` provider or a credential-complete model-callable provider; implemented-but-untested ordinary providers do not receive this check. `ProviderInfo.mcpServer` and `ProviderInfo.mcpTools` carry the MCP identity, exact tool names and user-facing descriptions shown when the source row is expanded; MCP rows suppress the generic setup steps, connection/status/credentials column and manual Sync icon because the green check already communicates readiness. `webSearchLlm` renders a setup-free panel with only a Web Search explanation and public site links. The internal `Свои источники` group and every `hiddenFromSources` provider are omitted without deleting their stored provenance.

`ProviderInfo.configFields` is the audited allow-list for the Configure modal. It can expose only `scope`, `url`, `format` and `keyword`, and each provider declares the subset its implementation actually consumes. Local display metadata (`language`, `audience`, source categories, priority and notes), the legacy `enabled` switch, connection instructions and credentials are not editable in this modal. Normalizers do not copy source-level language, audience or category defaults into imported entities; they retain only provider-returned or deterministically inferred classification. Expanded non-MCP cards keep diagnostics and documentation, but Test/Sync action buttons are removed there. API aggregators have both a group-level **Запустить** button and a row-level run icon; auxiliary sources in Other retain their row-level action.

Bilet.rs uses server-rendered `bilet.rs/events/` (the `app.bilet.rs` domain returns an application shell), combines the main JSON-LD ItemList with matching venue cards, and follows pagination up to 30 pages. It requests `countryCode=RS`, today's `startDate`, the source keyword, and `location=Beograd` for Belgrade. The returned form must confirm the city filter. Explicit other cities in venue text are excluded; the country-wide view leaves unknown cities empty. This location search has incomplete coverage when a venue is not labelled with the city. The generic feed adapter previously assigned the selected scope to every entry; that is unsuitable for an unfiltered country-wide list.

Serbia Travel reads the calendar's public `en/wp-json/event-listings/v1/get-events/` endpoint. Its response is HTML cards plus `hasMore`, not JSON-LD. The adapter checks that shape, parses actual city and date ranges, validates dates, filters cities locally, and follows at most 30 pages. There is no authentication or personal API key. Empty responses must be explicit; unknown HTML fails rather than masquerading as an empty calendar.

Afisha.rs has a dedicated adapter for the site's public Russian JSON listing at `/ru/api/term-content/0/all/{page}`. Page numbering starts at zero; the first response supplies `page_count` and `item_count`, and Sync sequentially reads every advertised page up to a hard limit of 100 with a 150–250 ms pause between calls. The `/ru` `all` feed already contains events from all site sections, so the adapter never reads the locale homepage, `/sr`, `/en` or individual section listings. Cards whose section or event path belongs to `/ru/deti` or `/ru/kino` are excluded before ingestion. It normalizes full descriptions, date ranges and local time, section/category, venue, image, price, event URL and ticket link. Provider IDs deduplicate cards before ingestion. Repeated pages and empty intermediate pages stop the run; a count change during pagination is surfaced as a warning. Migration `014_afisha_ru_sections.sql` pins existing Afisha sources to `/ru` and removes previously stored Afisha provenance from the excluded sections, deleting canonical cards only when they have no remaining source. Migration `015_afisha_homepage_cleanup.sql` removes provenance left by the former JSON-LD homepage reader; canonical cards backed by the paginated API remain intact. The endpoint is undocumented and may require adapter updates if its response changes.

Belgrade Beat has a dedicated weekly HTML adapter. Each sync fetches exactly `/events/this-week` and `/events/next-week` in sequence, with a randomized 2–3 second pause between the two requests and no automatic retry after rate limiting. It selects the desktop copy inside each `.js-event`, associates cards with their date heading, and normalizes the title, description, time, venue, tags, image and canonical event URL. Repeated listings and multi-day appearances are collapsed by canonical event URL before ingestion, keeping the earliest occurrence. The event slug is the stable provider external ID, so Store upsert treats a later run as an update or duplicate rather than a new entity. A separate `belgrade-beat-web` card under LLM Web is retained for model research outside the two weekly listing pages.

The Sources UI uses `otherSource` to move auxiliary sources from Connections to the separate **Другие** tab. OpenStreetMap and Ticketmaster are currently there. OpenStreetMap remains directly syncable even when its legacy stored `enabled` value is false. Migration `008_purge_openstreetmap_data.sql` removes previously collected OSM entities/raw items and disables the existing OSM source; fresh databases also retain that legacy value. Main connections are grouped by operating model: API Агрегаторы, MCP and LLM Web. Belgrade Beat is a working API aggregator and is no longer shown in Other. The API Aggregators heading owns the group-level **Запустить** control: the server batch handles ordinary aggregators, then the client opens the required AllEvents confirmation plan. Each aggregator row also has an icon that runs only that provider and preserves the AllEvents confirmation flow. MCP is excluded. Working local listings remain in Connections: Tickets.rs and Bilet.rs send today's lower date bound, Serbia Travel sends `start_date`, and AllEvents rejects ranges starting before today. A shared post-normalization rule marks past Event entities as filtered while preserving raw payload and provenance; it covers every source and can be disabled in the Activities UI.

Overpass tries one backup endpoint (`overpass.private.coffee`) after transient 502/503/504, transport failures or timeouts on the default public endpoint. It does not retry 429, replace a custom endpoint, or accept `remark` as a full response. Success using the backup is reported in warnings. Both requests are read-only and retain timeouts and size/address checks.

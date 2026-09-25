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

| Provider                  | Variables                              | Setup / what remains                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overpass                  | Optional `OVERPASS_URL`                | [Docs](https://wiki.openstreetmap.org/wiki/Overpass_API); works without key                                                                                                                                                                                           |
| Ticketmaster              | `TICKETMASTER_API_KEY`                 | [Create app](https://developer.ticketmaster.com/products-and-docs/tutorials/events-search/search_events_with_discovery_api.html), copy Consumer key, enable source, Test, Sync                                                                                        |
| Telegram MTProto          | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | [Create app](https://my.telegram.org), [API ID](https://core.telegram.org/api/obtaining_api_id); remaining: [Telethon](https://docs.telethon.dev/) worker and user session/auth outside SQLite                                                                        |
| TGStat                    | `TGSTAT_TOKEN`                         | [API docs](https://api.tgstat.ru/docs/ru/); remaining: discovery adapter; check current plan                                                                                                                                                                          |
| Instagram / Apify         | `APIFY_TOKEN`                          | [Profile Actor](https://apify.com/apify/instagram-api-scraper), [search Actor](https://apify.com/apify/instagram-search-scraper); remaining: paid Actor runner and dataset parser                                                                                     |
| Facebook / ScrapeCreators | `SCRAPECREATORS_API_KEY`               | [City](https://docs.scrapecreators.com/v1/facebook/events/), [search](https://docs.scrapecreators.com/v1/facebook/events/search/), [page](https://docs.scrapecreators.com/v1/facebook/profile/events/); remaining: endpoint adapter and method-specific configuration |
| Facebook / Apify          | `APIFY_TOKEN`                          | [Actor](https://apify.com/apify/facebook-events-scraper); remaining: runner / dataset parser                                                                                                                                                                          |
| Meetup                    | `MEETUP_ACCESS_TOKEN`                  | [GraphQL](https://www.meetup.com/graphql/guide/); remaining: authorized OAuth/refresh flow, GraphQL adapter; account access required                                                                                                                                  |
| Eventbrite                | `EVENTBRITE_TOKEN`                     | [OAuth](https://www.eventbrite.com/platform/docs/app-oauth-flow); remaining: organization-specific adapter; no assumed global discovery                                                                                                                               |
| PredictHQ                 | `PREDICTHQ_TOKEN`                      | [Docs](https://docs.predicthq.com/); remaining: events adapter, subscription/coverage verification                                                                                                                                                                    |
| Google Places             | `GOOGLE_PLACES_API_KEY`                | [Key setup](https://developers.google.com/maps/documentation/places/web-service/get-api-key); remaining: FieldMask enrichment with storage-policy handling; not a primary permanent database                                                                          |
| Foursquare                | `FOURSQUARE_API_KEY`                   | [Docs](https://docs.foursquare.com/data-products/docs/places-api); remaining: current-version enrichment adapter                                                                                                                                                      |

No API keys are prefilled. The user must obtain their own access and check the current conditions with the provider. Planned adapters explicitly return `setup_required` even if every variable is present.

Tickets.rs has a dedicated adapter in `websites/tickets.ts`. It reads the website's public application configuration and calls the same read-only JSON endpoints as its search page (`web__Get_PageConfig`, `web__Get_SearchMenu`, `web__Get_EventList`). No account or user API key is required; public application parameters are fetched per run and are never stored in raw records. This is an undocumented website interface, not a partner API.

Setup: use `https://tickets.rs/`, select Belgrade, enable, Test, Sync. The adapter resolves the search widget and city IDs dynamically, checks the server's selected city filter, and loads current/future events with pagination (up to 60 pages across Belgrade and its separately listed districts, including Zemun). The source keyword maps to search text. Serbia-wide import is not yet supported because list records do not include city/country and the catalog also includes foreign cities; the adapter must not label all results as Serbian.

Event IDs deduplicate repeated listings. Raw event fields and the town filter are preserved. Dates use Europe/Belgrade, with time only when supplied. Zero prices remain unknown, and undated vouchers are skipped with a warning. Categories/full descriptions are not available in list responses. Partial parsing and page limits produce warnings; changed configuration, ignored city filters, failed requests or broken pagination produce errors rather than false successful empty imports. Test checks parsing of the first city page; Sync loads the complete bounded selection.

`ProviderInfo.registration` identifies the actual account service and its URL. Source rows render a compact registration badge independently of enabled/connected/implemented state; setup details link to that account service. It is absent for public sources and manual import. `setupMessage` explains disabled integrations such as Belgrade Beat without suggesting that credentials would fix them.

Bilet.rs uses server-rendered `bilet.rs/events/` (the `app.bilet.rs` domain returns an application shell), combines the main JSON-LD ItemList with matching venue cards, and follows pagination up to 30 pages. It requests `countryCode=RS`, today's `startDate`, the source keyword, and `location=Beograd` for Belgrade. The returned form must confirm the city filter. Explicit other cities in venue text are excluded; the country-wide view leaves unknown cities empty. This location search has incomplete coverage when a venue is not labelled with the city. The generic feed adapter previously assigned the selected scope to every entry; that is unsuitable for an unfiltered country-wide list.

Serbia Travel reads the calendar's public `en/wp-json/event-listings/v1/get-events/` endpoint. Its response is HTML cards plus `hasMore`, not JSON-LD. The adapter checks that shape, parses actual city and date ranges, validates dates, filters cities locally, and follows at most 30 pages. There is no authentication or personal API key. Empty responses must be explicit; unknown HTML fails rather than masquerading as an empty calendar.

Afisha.rs remains a limited, verified JSON-LD reader for its homepage selection (12 records at audit), with explicit coverage limits. Belgrade Beat returned HTTP 403 from the server and its general JSON-LD integration was unverified; it is now an unavailable planned adapter, with Test/Sync disabled and a concrete reason.

Overpass tries one backup endpoint (`overpass.private.coffee`) after transient 502/503/504, transport failures or timeouts on the default public endpoint. It does not retry 429, replace a custom endpoint, or accept `remark` as a full response. Success using the backup is reported in warnings. Both requests are read-only and retain timeouts and size/address checks.

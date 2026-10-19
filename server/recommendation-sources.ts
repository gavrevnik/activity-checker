import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Store } from "./store.js";
import { providers } from "./providers/registry.js";
import { readTelegramMonitoringSettings } from "./telegram-monitoring-settings.js";
import { telegramUsername } from "../shared/telegram-monitoring.js";
import type {
  RecommendationItem,
  RecommendationSearchSource,
  RecommendationSourcesView,
} from "../shared/recommendations.js";

const knowledgeRoot = fileURLToPath(
  new URL("../../personal-radar/", import.meta.url),
);
const manifestSchema = z.object({
  data_revision: z.string(),
  datasets: z.object({
    sources: z.object({ paths: z.array(z.string().min(1)).min(1) }),
    collections: z.unknown().optional(),
  }),
});
const venueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().default(""),
  locator: z.string().min(1),
  access: z.object({
    method: z.literal("web_search"),
    search_domains: z.array(z.string()).default([]),
  }),
  metadata: z.object({
    source_kind: z.enum(["venue", "organizer"]),
    discovery_priority: z.enum(["P1", "P2", "P3"]),
    event_types: z.array(z.string()),
    genres: z.array(z.string()),
    page_type: z.enum([
      "official_calendar",
      "official_social",
      "aggregator_listing",
      "ticketing_listing",
      "venue_info_only",
    ]),
    calendar_availability: z.string().min(1),
    checked_on: z.string().min(1),
    pages: z.array(
      z.object({
        url: z.string(),
        page_type: z.string(),
        availability: z.string(),
        publisher_kind: z.enum(["venue", "organizer"]).optional(),
      }),
    ),
  }),
});

// All manifest and record paths remain inside the local generated indexes,
// including after symlink resolution. No network or SQLite catalog sync.
function readIndex(root: string, path: string, extension: ".json" | ".jsonl") {
  const indexes = resolve(root, "knowledge/indexes"),
    file = resolve(root, path);
  if (
    !file.startsWith(indexes + sep) ||
    !file.endsWith(extension) ||
    !realpathSync(file).startsWith(realpathSync(indexes) + sep)
  )
    throw Error("Invalid Knowledge index path");
  return readFileSync(file, "utf8");
}
function readRows(root: string, paths: string[], format: "json" | "jsonl") {
  return paths.flatMap((path) => {
    const text = readIndex(root, path, format === "json" ? ".json" : ".jsonl");
    return format === "json"
      ? z.array(z.any()).parse(JSON.parse(text))
      : text
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
  });
}
const urlIdentity = (value: string) => {
  const safe = httpUrl(value);
  if (!safe) return "";
  const url = new URL(safe);
  return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "");
};
const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  locator: z.string(),
  summary: z.string().nullish(),
  metadata: z
    .object({
      username: z.string().nullish(),
      description: z.string().nullish(),
    })
    .passthrough(),
});
const httpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
};
const host = (value: string) => {
  const url = httpUrl(value);
  return url ? new URL(url).hostname.replace(/^www\./, "") : "";
};

// Untagged legacy sources retain their Serbia scope; never leak them into a new country.
function sourceMatchesScope(raw: any, scope: ReturnType<Store["scope"]>) {
  const countryAliases: Record<string, string> = {
    Serbia: "RS",
    Moldova: "MD",
  };
  const country = raw.metadata?.country;
  const code = country ? countryAliases[country] || country : "RS";
  if (code !== scope.country) return false;
  const normalizeCity = (city: string) =>
    city.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const city = raw.metadata?.city;
  return (
    !scope.city || !city || normalizeCity(city) === normalizeCity(scope.city)
  );
}

export function recommendationSearchSources(
  store: Store,
  scopeId: string,
  items: RecommendationItem[] = [],
  root = knowledgeRoot,
): RecommendationSourcesView {
  const scope = store.scope(scopeId);
  const excluded = new Set(
    readTelegramMonitoringSettings(store.db).excludedChannels,
  );
  let knowledgeWeb: RecommendationSearchSource[] = [];
  let telegram: RecommendationSearchSource[] = [],
    venues: RecommendationSearchSource[] = [],
    venueWarning: string | null = null,
    knowledgeRevision: string | null = null,
    warning: string | null = null;
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(
        readFileSync(resolve(root, "knowledge/indexes/manifest.json"), "utf8"),
      ),
    );
    const rows = readRows(root, manifest.datasets.sources.paths, "jsonl");
    knowledgeWeb = rows.flatMap<RecommendationSearchSource>((raw) => {
      if (
        raw.enabled !== true ||
        raw.platform !== "web" ||
        raw.access?.method !== "web_search" ||
        !raw.domains?.includes("activities") ||
        !raw.roles?.includes("activity_monitoring") ||
        !sourceMatchesScope(raw, scope)
      )
        return [];
      const url = httpUrl(raw.locator);
      if (!url || typeof raw.id !== "string" || typeof raw.name !== "string")
        return [];
      return [
        {
          id: raw.id,
          name: raw.name,
          url,
          method: "web",
          enabled: true,
          description:
            raw.summary || "Целевой веб-поиск по источнику Knowledge",
        },
      ];
    });
    const unique = new Map<string, RecommendationSearchSource>();
    for (const raw of rows) {
      // Same collection as activity-recommendations; no list copied from SQLite.
      if (
        raw.platform !== "telegram" ||
        raw.enabled !== true ||
        !Array.isArray(raw.domains) ||
        !raw.domains.includes("activities") ||
        !Array.isArray(raw.roles) ||
        !raw.roles.includes("activity_monitoring") ||
        !(
          raw.metadata?.telegram_kind === "channel" ||
          (raw.metadata?.telegram_kind === "group" &&
            raw.access?.method === "personal_radar_mcp" &&
            raw.access?.tool === "telegram_read_messages")
        ) ||
        !sourceMatchesScope(raw, scope)
      )
        continue;
      const channel = channelSchema.parse(raw);
      const username = telegramUsername(
        channel.metadata.username || channel.locator,
      );
      const key = username || channel.id;
      if (unique.has(key)) continue;
      const enabled = !excluded.has(username);
      unique.set(key, {
        id: channel.id,
        name: channel.name,
        url: httpUrl(channel.locator),
        method: "telegram",
        enabled,
        description: enabled
          ? channel.summary ||
            channel.metadata.description ||
            (username ? "@" + username : "")
          : "Исключён в настройках мониторинга Telegram",
      });
    }
    telegram = [...unique.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "ru"),
    );
    knowledgeRevision = manifest.data_revision;
    if (scopeId === "belgrade") {
      try {
        const dataset = z
          .object({
            paths: z.array(z.string().min(1)).min(1),
            format: z.enum(["json", "jsonl"]),
          })
          .parse(manifest.datasets.collections);
        const collections = readRows(root, dataset.paths, dataset.format);
        const records = new Map(rows.map((row) => [row.id, row]));
        const selected = new Map<string, RecommendationSearchSource>();
        const identities = new Set<string>();
        for (const [id, kind] of [
          ["belgrade-live-venues", "venue"],
          ["belgrade-live-organizers", "organizer"],
        ] as const) {
          const matches = collections.filter((c) => c.id === id);
          if (matches.length !== 1 || matches[0].member_type !== "source")
            throw Error("Missing venue collection");
          const members = z.array(z.string().min(1)).parse(matches[0].members);
          for (const member of members) {
            const row = records.get(member);
            if (!row) throw Error("Missing venue record");
            if (
              row.enabled !== true ||
              row.platform !== "web" ||
              row.access?.method !== "web_search" ||
              !row.domains?.includes("activities") ||
              !row.roles?.includes(
                kind === "venue"
                  ? "venue_event_discovery"
                  : "organizer_event_discovery",
              ) ||
              row.metadata?.country !== "Serbia" ||
              row.metadata?.city !== "Belgrade"
            )
              continue;
            const detail = JSON.parse(
              readIndex(root, z.string().parse(row.record_path), ".json"),
            );
            if (
              detail.id !== member ||
              detail.enabled !== row.enabled ||
              detail.locator !== row.locator ||
              detail.metadata?.city !== row.metadata.city ||
              detail.metadata?.country !== row.metadata.country
            )
              throw Error("Inconsistent venue record");
            const source = venueSchema.parse(detail),
              meta = source.metadata;
            const url = httpUrl(source.locator);
            if (!url || meta.source_kind !== kind)
              throw Error("Invalid venue identity");
            if (selected.has(source.id) || identities.has(urlIdentity(url)))
              continue;
            const afishaVenueUrl = meta.pages
              .filter((page) => page.availability === "readable")
              .map((page) => page.url)
              .find((url) =>
                /^https:\/\/afisha\.rs\/ru\/venues\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(
                  url,
                ),
              )
              ?.replace(/\/$/, "");
            selected.set(source.id, {
              id: source.id,
              name: source.name,
              url,
              description: source.summary,
              method: "web",
              enabled: true,
              venue: {
                kind,
                ...(afishaVenueUrl ? { afishaVenueUrl } : {}),
                priority: meta.discovery_priority,
                eventTypes: meta.event_types,
                genres: meta.genres,
                aliases: source.aliases,
                searchDomains: source.access.search_domains,
                pageType: meta.page_type,
                calendarAvailability: meta.calendar_availability,
                checkedOn: meta.checked_on,
                pages: meta.pages.flatMap((p) =>
                  httpUrl(p.url)
                    ? [
                        {
                          url: httpUrl(p.url),
                          pageType: p.page_type,
                          availability: p.availability,
                          ...(p.publisher_kind
                            ? { publisherKind: p.publisher_kind }
                            : {}),
                        },
                      ]
                    : [],
                ),
              },
            });
            identities.add(urlIdentity(url));
          }
        }
        venues = [...selected.values()].sort(
          (a, b) =>
            a.venue!.priority.localeCompare(b.venue!.priority) ||
            a.name.localeCompare(b.name, "ru"),
        );
      } catch {
        venueWarning =
          "Не удалось прочитать концертные площадки и организаторов из Knowledge Personal Radar. Проверьте коллекции и индексы; покрытие площадок не подтверждено.";
      }
    }
  } catch {
    warning =
      "Не удалось прочитать список Telegram из Knowledge Personal Radar. Проверьте локальный каталог и его индексы.";
    if (scopeId === "belgrade")
      venueWarning = "Каталог концертных площадок Knowledge недоступен.";
  }
  const venueIds = new Set(venues.map((source) => source.id));
  const venueUrls = new Set(
    venues
      .flatMap((source) => [
        source.url,
        ...source.venue!.pages.map((p) => p.url),
      ])
      .map(urlIdentity),
  );
  const other: RecommendationSearchSource[] = store
    .sources()
    .flatMap<RecommendationSearchSource>((source) => {
      const provider = providers.find((p) => p.id === source.providerId);
      if (
        !provider ||
        provider.hiddenFromSources ||
        !provider.supportedEntityTypes.includes("Event")
      )
        return [];
      const web = provider.webSearchLlm === true;
      if (
        !web &&
        (provider.group !== "API Агрегаторы" ||
          !source.enabled ||
          !provider.implemented)
      )
        return [];
      const sourceScope = store.scope(source.scopeId);
      if (
        sourceScope.country !== scope.country ||
        (scope.city && sourceScope.city && sourceScope.id !== scopeId)
      )
        return [];
      const url =
        [source.url, provider.defaultUrl, ...provider.docs.map((d) => d.url)]
          .filter((v): v is string => !!v)
          .map(httpUrl)
          .find(Boolean) || "";
      if (venueIds.has(source.id) || (url && venueUrls.has(urlIdentity(url))))
        return [];
      return [
        {
          id: source.id,
          name: source.name,
          url,
          method: web ? "web" : "aggregator",
          enabled: true,
          description: web
            ? "Веб-поиск модели по публичным страницам"
            : "Подключённый агрегатор · обновление через сервис",
        },
      ];
    })
    .sort(
      (a, b) =>
        a.method.localeCompare(b.method) || a.name.localeCompare(b.name, "ru"),
    );
  const otherIdentities = new Set(other.map((s) => urlIdentity(s.url)));
  for (const source of knowledgeWeb) {
    if (!otherIdentities.has(urlIdentity(source.url))) {
      other.push(source);
      otherIdentities.add(urlIdentity(source.url));
    }
  }
  other.sort(
    (a, b) =>
      a.method.localeCompare(b.method) || a.name.localeCompare(b.name, "ru"),
  );
  const knownHosts = new Set([...other, ...venues].map((s) => host(s.url)));
  const additionalMap = new Map<string, RecommendationSearchSource>();
  for (const item of items)
    for (const value of new Set([item.sourceUrl, item.eventUrl])) {
      const domain = host(value);
      if (
        !domain ||
        [
          "t.me",
          "telegram.me",
          "forms.gle",
          "docs.google.com",
          "maps.app.goo.gl",
          "goo.gl",
          "maps.google.com",
        ].includes(domain) ||
        knownHosts.has(domain) ||
        additionalMap.has(domain)
      )
        continue;
      additionalMap.set(domain, {
        id: "snapshot:" + domain,
        name: value === item.sourceUrl ? item.sourceName : domain,
        url: httpUrl(value),
        method: "snapshot",
        enabled: true,
        description: "Источник из сохранённой подборки · " + domain,
      });
    }
  return {
    telegram,
    venues,
    venueWarning,
    other,
    additional: [...additionalMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "ru"),
    ),
    knowledgeRevision,
    warning,
  };
}

// Geography evidence from verified venue records; never infer it from the site's footer.
export function knowledgeVenueCities(country: string, root = knowledgeRoot) {
  const manifest = manifestSchema.parse(
    JSON.parse(
      readFileSync(resolve(root, "knowledge/indexes/manifest.json"), "utf8"),
    ),
  );
  const out: Record<string, string> = {};
  for (const row of readRows(root, manifest.datasets.sources.paths, "jsonl")) {
    if (
      row.enabled !== true ||
      row.metadata?.country !== country ||
      typeof row.metadata?.city !== "string" ||
      !row.roles?.includes("venue_event_discovery")
    )
      continue;
    const raw = JSON.parse(
      readIndex(root, z.string().parse(row.record_path), ".json"),
    );
    if (
      raw.id !== row.id ||
      raw.enabled !== true ||
      raw.metadata?.source_kind !== "venue" ||
      raw.metadata.country !== country ||
      raw.metadata.city !== row.metadata.city
    )
      throw Error("Inconsistent venue geography");
    for (const name of [raw.name, ...(raw.aliases || [])]) {
      if (typeof name === "string" && name.trim())
        out[name.trim()] = raw.metadata.city;
    }
  }
  return out;
}

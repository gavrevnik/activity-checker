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
  }),
});
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
  let telegram: RecommendationSearchSource[] = [],
    knowledgeRevision: string | null = null,
    warning: string | null = null;
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(
        readFileSync(resolve(root, "knowledge/indexes/manifest.json"), "utf8"),
      ),
    );
    const indexes = resolve(root, "knowledge/indexes"),
      realIndexes = realpathSync(indexes);
    const unique = new Map<string, RecommendationSearchSource>();
    for (const path of manifest.datasets.sources.paths) {
      const file = resolve(root, path);
      if (
        !file.startsWith(indexes + sep) ||
        !file.endsWith(".jsonl") ||
        !realpathSync(file).startsWith(realIndexes + sep)
      )
        throw Error("Invalid source index path");
      for (const line of readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim())) {
        const raw = JSON.parse(line);
        // Same collection as activity-recommendations; no list copied from SQLite.
        if (
          raw.platform !== "telegram" ||
          raw.enabled !== true ||
          !Array.isArray(raw.domains) ||
          !raw.domains.includes("activities") ||
          !Array.isArray(raw.roles) ||
          !raw.roles.includes("activity_monitoring") ||
          raw.metadata?.telegram_kind !== "channel"
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
    }
    telegram = [...unique.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "ru"),
    );
    knowledgeRevision = manifest.data_revision;
  } catch {
    warning =
      "Не удалось прочитать список Telegram из Knowledge Personal Radar. Проверьте локальный каталог и его индексы.";
  }
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
  const knownHosts = new Set(other.map((s) => host(s.url)));
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
    other,
    additional: [...additionalMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "ru"),
    ),
    knowledgeRevision,
    warning,
  };
}

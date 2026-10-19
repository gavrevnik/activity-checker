import type { Store } from "./store.js";
import { recommendationSearchSources } from "./recommendation-sources.js";

/** Local metadata only: no Telegram RPC, joining, credentials or Knowledge writes. */
export function prepareRecommendationTelegramSources(
  store: Store,
  scopeId: string,
  knowledgeRoot?: string,
) {
  const scope = store.scope(scopeId);
  const catalog = recommendationSearchSources(
    store,
    scopeId,
    [],
    knowledgeRoot,
  );
  if (catalog.warning) throw Error(catalog.warning);
  const channels = catalog.telegram.filter((item) => item.enabled);
  const result = store.ingest(
    store.source("source-telegram"),
    channels.map((channel) => {
      const username = new URL(channel.url).pathname
        .split("/")
        .filter(Boolean)[0];
      if (!username || !/^[a-zA-Z0-9_]+$/.test(username))
        throw Error("В Knowledge нет публичного Telegram username.");
      return {
        entity: {
          type: "Community" as const,
          title: channel.name,
          description: channel.description,
          country: scope.country,
          city: scope.city || "",
          category: "Общение",
          tags: ["telegram", "recommendation-source"],
          url: `https://t.me/${username}`,
          externalId: `knowledge:${channel.id}`,
          knownIds: { telegram_username: username },
        },
        raw: {
          externalId: `knowledge:${channel.id}`,
          url: channel.url,
          rawText: channel.description,
          payload: {
            knowledgeSourceId: channel.id,
            knowledgeRevision: catalog.knowledgeRevision,
          },
        },
      };
    }),
  );
  const usernames = new Set(
    channels.map((item) =>
      new URL(item.url).pathname.split("/").filter(Boolean)[0].toLowerCase(),
    ),
  );
  return {
    created: result.created,
    updated: result.updated,
    channels: store
      .entities({ includeFiltered: true })
      .filter(
        (item) =>
          item.type === "Community" &&
          usernames.has((item.knownIds.telegram_username || "").toLowerCase()),
      )
      .map((item) => ({
        communityId: item.id,
        username: item.knownIds.telegram_username,
        title: item.title,
      })),
  };
}

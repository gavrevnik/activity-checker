import { z } from "zod";
import type { Store } from "./store.js";
import { SyncService } from "./sync.js";
import { getProvider } from "./providers/registry.js";
import { publicUrl, withAggregatorNetwork } from "./public-fetch.js";
import { autoArchivePastEvents } from "./auto-archive.js";
import { syncOptionsSchema } from "../shared/model.js";

export const AGGREGATOR_HOSTS: Record<string, ReadonlySet<string>> = {
  tickets: new Set(["tickets.rs", "www.tickets.rs"]), bilet: new Set(["bilet.rs", "www.bilet.rs"]),
  afisha: new Set(["afisha.rs", "www.afisha.rs"]),
  "belgrade-beat": new Set(["belgrade-beat.com", "www.belgrade-beat.com"]),
  "serbia-travel": new Set(["serbia.travel", "www.serbia.travel"]),
  allevents: new Set(["allevents.in", "www.allevents.in"]),
};
export const scopeInput = z.object({scopeId: z.string().min(1).max(100).default("belgrade")}).strict();
export const aggregatorInput = syncOptionsSchema.pick({confirmed: true, startDate: true, endDate: true, categories: true, previewId: true}).extend({
  sourceId: z.string().min(1).max(200), maxRequests: z.number().int().min(1).max(100).default(60),
}).strict();

export class AggregatorTools {
  private sync: SyncService;
  constructor(private store: Store) { this.sync = new SyncService(store); }
  private source(id: string) {
    const source = this.store.source(id);
    const hosts = AGGREGATOR_HOSTS[source.providerId];
    if (!hosts) throw new Error("Этот провайдер не входит в разрешённые обычные агрегаторы.");
    const provider = getProvider(source.providerId);
    publicUrl(source.url || provider.defaultUrl || "", hosts);
    return {source, hosts};
  }
  status(scopeId = "belgrade") {
    const scope = this.store.scope(scopeId);
    return this.store.sources().filter(s => {
      if (!AGGREGATOR_HOSTS[s.providerId]) return false;
      const sourceScope = this.store.scope(s.scopeId);
      return s.scopeId === scopeId || (sourceScope.country === scope.country && (!scope.city || !sourceScope.city));
    }).map(s => {
      const provider = getProvider(s.providerId);
      const connection = provider.connectionStatus({source:s,scope:this.store.scope(s.scopeId),secrets:{}});
      let available = connection.canSync;
      try { this.source(s.id); } catch { available = false; }
      return {sourceId: s.id, providerId: s.providerId, name: s.name, scopeId: s.scopeId,
        available, enabled: s.enabled, lastSyncAt: s.lastSyncAt, lastAttemptAt: s.lastAttemptAt, status: s.status,
        lastResult: s.lastResult, connectionMessage: connection.message, requiresConfirmation: Boolean(provider.requiresSyncConfirmation),
        instructions: provider.requiresSyncConfirmation ? "Сначала plan, проверь параметры и previewId. Запрос пользователя на дайджест/обновление разрешает этот бесплатный sync с confirmed=true; отдельный вопрос не нужен." : "Sync разрешён по запросу обновления/дайджеста; не нужен новый источник или URL."};
    });
  }
  async plan(input: z.input<typeof aggregatorInput>) {
    const {sourceId, maxRequests, ...options} = aggregatorInput.parse(input);
    const {hosts} = this.source(sourceId);
    return withAggregatorNetwork(hosts, maxRequests, () => this.sync.plan(sourceId, options));
  }
  async run(input: z.input<typeof aggregatorInput>) {
    const {sourceId, maxRequests, ...options} = aggregatorInput.parse(input);
    const {source, hosts} = this.source(sourceId);
    if (source.providerId === "allevents" && (!options.confirmed || !options.previewId))
      throw new Error("AllEvents: нужен действующий план previewId и confirmed=true в рамках разрешённого обновления/дайджеста.");
    return withAggregatorNetwork(hosts, maxRequests, () => this.sync.run(sourceId, false, options));
  }
  history(scopeId = "belgrade") {
    const sources = new Set(this.status(scopeId).map(s => s.sourceId));
    return this.sync.runs().filter(run => sources.has(run.sourceId));
  }
  archive(scopeId = "belgrade") {
    this.store.scope(scopeId);
    return autoArchivePastEvents(this.store, scopeId);
  }
}

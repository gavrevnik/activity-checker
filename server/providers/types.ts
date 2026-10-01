import type {
  Connection,
  EntityInput,
  ProviderInfo,
  Scope,
  Source,
  SyncOptions,
  SyncPlan,
} from "../../shared/model.js";
import type { Store } from "../store.js";
export interface RawItem {
  externalId: string;
  url: string;
  rawText: string;
  payload: unknown;
  publishedAt?: string;
}
export interface ProviderContext {
  source: Source;
  scope: Scope;
  secrets: Record<string, string | undefined>;
  store?: Store;
}
export interface FetchResult {
  items: RawItem[];
  warnings?: string[];
}
export interface ActivityProvider extends ProviderInfo {
  connectionStatus(ctx: ProviderContext): Connection;
  testConnection(ctx: ProviderContext): Promise<string>;
  planSync?(ctx: ProviderContext, options: SyncOptions): Promise<SyncPlan>;
  sync(ctx: ProviderContext, options?: SyncOptions): Promise<FetchResult>;
  normalize(item: RawItem, ctx: ProviderContext): EntityInput | null;
}
export const statusFor = (
  info: ProviderInfo,
  ctx: ProviderContext,
): Connection => {
  const credentials = info.credentials.map((c) => ({
    key: c.key,
    present: !!ctx.secrets[c.key]?.trim(),
  }));
  const base = { credentials, canSync: false, canTest: false };
  if (
    !info.supportedScopes.includes("*") &&
    !info.supportedScopes.includes(ctx.scope.id)
  )
    return {
      ...base,
      status: "setup_required",
      message: "Провайдер не поддерживает выбранную географию",
    };
  if (!info.implemented)
    return {
      ...base,
      status: "setup_required",
      message:
        info.setupMessage || "Адаптер запланирован · инструкция доступна",
    };
  if (credentials.some((c) => !c.present))
    return {
      ...base,
      status: "not_configured",
      message: "Добавьте ключи в .env.local",
    };
  if (info.mode === "manual")
    return {
      ...base,
      status: "ready",
      message: "Ручное добавление и JSON-импорт",
    };
  if (info.providerType === "Website/Aggregator" && !ctx.source.url)
    return {
      ...base,
      status: "not_configured",
      message: "Укажите URL сайта или ленты",
    };
  return {
    ...base,
    status: ctx.source.lastError
      ? "error"
      : ctx.source.status === "connected"
        ? "connected"
        : "ready",
    message:
      ctx.source.lastError ||
      (ctx.source.status === "connected"
        ? "Подключение проверено"
        : "Готов к синхронизации"),
    canSync: true,
    canTest: true,
  };
};
export function defineProvider(
  info: ProviderInfo,
  implementation: Pick<
    ActivityProvider,
    "sync" | "normalize" | "testConnection"
  > &
    Partial<Pick<ActivityProvider, "planSync">>,
): ActivityProvider {
  return {
    ...info,
    ...implementation,
    connectionStatus: (ctx) => statusFor(info, ctx),
  };
}
export function planned(
  info: Omit<ProviderInfo, "implemented">,
): ActivityProvider {
  return defineProvider(
    { ...info, implemented: false },
    {
      async sync() {
        throw new Error(
          "Для этого источника ещё требуется реализация адаптера. См. инструкцию подключения.",
        );
      },
      async testConnection() {
        throw new Error(
          "Адаптер ещё не реализован: наличие ключа не означает подключения.",
        );
      },
      normalize() {
        return null;
      },
    },
  );
}

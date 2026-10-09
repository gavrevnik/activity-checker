import { CatalogPanel } from "./CatalogPanel";
import { useState } from "react";
import {
  RefreshCw,
  Plug,
  ChevronDown,
  Check,
  KeyRound,
  Link,
  Pause,
  Info,
  ArrowUpRight,
  History,
  UserRound,
} from "lucide-react";
import type { Candidate, Scope, SourceView, SyncRun } from "../shared/model";
import { Button, External, Empty, Stats, Busy } from "./components";
import { AutoArchiveSetting } from "./AutoArchiveSetting";
const statusLabels: Record<string, string> = {
  disabled: "Выключен",
  not_configured: "Нужен ключ",
  setup_required: "Нужен адаптер",
  ready: "Готов",
  connected: "Подключён",
  error: "Ошибка",
};
const formatTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Ещё не запускался";
const hasWorkingConnection = (source: SourceView) =>
  source.connection.status === "connected" ||
  (source.provider.modelCallable === true &&
    source.connection.credentials.every((credential) => credential.present));
export function Sources({
  sources,
  scopes,
  scope,
  candidates,
  runs,
  busy,
  onEdit,
  onAction,
  onSyncAll,
  onCandidate,
  onOpen,
}: {
  sources: SourceView[];
  scopes: Scope[];
  scope: Scope;
  candidates: Candidate[];
  runs: SyncRun[];
  busy: string;
  onEdit: (source: SourceView) => void;
  onAction: (source: SourceView, action: "test" | "sync") => void;
  onSyncAll: () => void;
  onCandidate: (id: string, action: "accept" | "ignore") => void;
  onOpen: (id: string) => void;
}) {
  const [tab, setTab] = useState("connections"),
    [expanded, setExpanded] = useState<string | null>(null);
  const local = sources.filter((s) => {
    const location = scopes.find((l) => l.id === s.scopeId);
    return (
      location?.country === scope.country &&
      (!scope.city || location?.city === scope.city)
    );
  });
  const listed = local.filter(
    (s) =>
      s.provider.group !== "Свои источники" && !s.provider.hiddenFromSources,
  );
  const primary = listed.filter((s) => !s.provider.otherSource);
  const other = listed.filter((s) => s.provider.otherSource);
  const selectedSources = tab === "other" ? other : primary;
  const visible = selectedSources;
  const preferredGroups = ["API Агрегаторы", "MCP", "LLM Web", "Другое"];
  const availableGroups = new Set(
    visible.map((source) => source.provider.group),
  );
  const groups = [
    ...preferredGroups.filter((group) => availableGroups.has(group)),
    ...[...availableGroups].filter((group) => !preferredGroups.includes(group)),
  ];
  const discovered = candidates.filter(
    (c) => c.status === "new" && (!scope.city || c.scopeId === scope.id),
  );
  return (
    <>
      <div className="page-heading">
        <div className="heading-title">
          <h1>Источники</h1>
          <span className="count">{listed.length}</span>
        </div>
      </div>
      <CatalogPanel />
      <AutoArchiveSetting />
      <div className="type-tabs">
        <button
          className={tab === "connections" ? "selected" : ""}
          onClick={() => setTab("connections")}
        >
          <Plug size={15} />
          Подключения<small>{primary.length}</small>
        </button>
        <button
          className={tab === "other" ? "selected" : ""}
          onClick={() => setTab("other")}
        >
          <Pause size={15} />
          Другие<small>{other.length}</small>
        </button>
        <button
          className={tab === "discovered" ? "selected" : ""}
          onClick={() => setTab("discovered")}
        >
          <Link size={15} />
          Найденные<small>{discovered.length}</small>
        </button>
        <button
          className={tab === "history" ? "selected" : ""}
          onClick={() => setTab("history")}
        >
          <History size={15} />
          История
        </button>
      </div>
      {(tab === "connections" || tab === "other") && (
        <>
          {tab === "other" && (
            <div className="source-help">
              <Info size={15} />
              <span>
                Здесь собраны вспомогательные источники. OpenStreetMap можно
                синхронизировать вручную, а Ticketmaster вынесен сюда из-за
                слабого покрытия Белграда и Сербии.
              </span>
            </div>
          )}
          {groups.map((group) => {
            const list = visible.filter((s) => s.provider.group === group);
            return list.length ? (
              <section className="source-group" key={group}>
                <div className="source-group-heading">
                  <h2>
                    {group}
                    <small>{list.length}</small>
                  </h2>
                  {group === "API Агрегаторы" && (
                    <Button
                      disabled={
                        !!busy || !list.some((s) => s.connection.canSync)
                      }
                      onClick={onSyncAll}
                    >
                      {busy === "all" ? <Busy /> : <RefreshCw size={15} />}
                      Запустить
                    </Button>
                  )}
                </div>
                <div className="source-list">
                  {list.map((s) => (
                    <div
                      key={s.id}
                      className={`source-item ${expanded === s.id ? "expanded" : ""}`}
                    >
                      <div className="source-row">
                        <div className={`provider-mark ${s.providerId}`}>
                          <Plug size={18} />
                        </div>
                        <button
                          className="source-identity"
                          onClick={() =>
                            setExpanded(expanded === s.id ? null : s.id)
                          }
                          aria-expanded={expanded === s.id}
                        >
                          <strong>
                            {s.name}
                            {hasWorkingConnection(s) && (
                              <span
                                className="working-connection-check"
                                title={
                                  s.connection.status === "connected"
                                    ? "Подключение проверено, источник работает"
                                    : s.provider.mcpTools?.length
                                      ? "Источник доступен модели через MCP"
                                      : "Источник доступен модели через локальный tool"
                                }
                                aria-label={
                                  s.connection.status === "connected"
                                    ? "Подключение проверено, источник работает"
                                    : s.provider.mcpTools?.length
                                      ? "Источник доступен модели через MCP"
                                      : "Источник доступен модели через локальный tool"
                                }
                                role="img"
                              >
                                <Check size={11} aria-hidden="true" />
                              </span>
                            )}
                            {s.provider.registration &&
                              !hasWorkingConnection(s) && (
                                <span
                                  className="registration-badge"
                                  title={`Для API-доступа нужен аккаунт ${s.provider.registration.service}. Инструкция — в подключении.`}
                                >
                                  <UserRound size={10} aria-hidden="true" />
                                  Регистрация
                                </span>
                              )}
                          </strong>
                          <span>{s.provider.description}</span>
                        </button>
                        <div className="source-metrics">
                          <span
                            className={`connection-badge ${s.connection.status}`}
                          >
                            <i />
                            {s.provider.webSearchLlm
                              ? "LLM Web"
                              : s.provider.browserOnly
                                ? "Только браузер"
                                : s.provider.mode === "manual"
                                  ? "Ручной импорт"
                                  : statusLabels[s.connection.status]}
                            {!s.provider.implemented &&
                            s.connection.status === "disabled" &&
                            !s.provider.webSearchLlm
                              ? " · заготовка"
                              : ""}
                          </span>
                          {s.quotaUsage && (
                            <span
                              className="source-quota"
                              title={`Google Places Pro за ${s.quotaUsage.billingMonth}: использовано ${s.quotaUsage.used}, осталось ${s.quotaUsage.remaining}`}
                            >
                              Pro {s.quotaUsage.used.toLocaleString("ru-RU")}/
                              {s.quotaUsage.limit.toLocaleString("ru-RU")}
                            </span>
                          )}
                          {s.enterpriseQuotaUsage && (
                            <span
                              className="source-quota"
                              title={`Google Places Enterprise за ${s.enterpriseQuotaUsage.billingMonth}: использовано ${s.enterpriseQuotaUsage.used}, осталось ${s.enterpriseQuotaUsage.remaining}`}
                            >
                              Enterprise{" "}
                              {s.enterpriseQuotaUsage.used.toLocaleString(
                                "ru-RU",
                              )}
                              /
                              {s.enterpriseQuotaUsage.limit.toLocaleString(
                                "ru-RU",
                              )}
                            </span>
                          )}
                          <small>
                            {s.itemCount
                              ? `${s.itemCount} записей`
                              : "Нет записей"}{" "}
                            · {scopes.find((l) => l.id === s.scopeId)?.name}
                          </small>
                        </div>
                        <div className="source-row-actions">
                          {!s.provider.webSearchLlm && (
                            <>
                              {!!s.provider.configFields.length && (
                                <Button onClick={() => onEdit(s)}>
                                  Настроить
                                </Button>
                              )}
                              {s.provider.group !== "MCP" && (
                                <Button
                                  title="Запустить источник"
                                  disabled={!!busy || !s.connection.canSync}
                                  onClick={() => onAction(s, "sync")}
                                >
                                  {busy === s.id ? (
                                    <Busy />
                                  ) : (
                                    <RefreshCw size={15} />
                                  )}
                                </Button>
                              )}
                            </>
                          )}
                          <button
                            className="icon-button"
                            aria-label={"Инструкция: " + s.name}
                            aria-expanded={expanded === s.id}
                            onClick={() =>
                              setExpanded(expanded === s.id ? null : s.id)
                            }
                          >
                            <ChevronDown size={17} />
                          </button>
                        </div>
                      </div>
                      {expanded === s.id && (
                        <div
                          className={`source-details ${s.provider.group === "MCP" ? "mcp-details" : ""}`}
                        >
                          {s.provider.webSearchLlm ? (
                            <section className="llm-web-panel">
                              <h3>Поиск через LLM Web</h3>
                              <p>
                                Для этого сервиса не настраивается локальный
                                API-адаптер. Модель ищет индексированные
                                публичные страницы сервиса через Web Search и
                                возвращает найденные события или сообщества для
                                проверки перед импортом.
                              </p>
                              <div className="doc-links">
                                {s.provider.docs.map((doc) => (
                                  <External key={doc.url} href={doc.url}>
                                    {doc.label}
                                  </External>
                                ))}
                              </div>
                            </section>
                          ) : (
                            <>
                              <div className="setup-column">
                                {s.provider.group !== "MCP" && (
                                  <>
                                    <h3>Подключение</h3>
                                    <ol>
                                      {s.provider.steps.map((step) => (
                                        <li key={step}>{step}</li>
                                      ))}
                                    </ol>
                                  </>
                                )}
                                <div className="doc-links">
                                  {s.provider.registration && (
                                    <External
                                      href={s.provider.registration.url}
                                    >
                                      Аккаунт {s.provider.registration.service}
                                    </External>
                                  )}
                                  {s.provider.docs.map((d) => (
                                    <External key={d.url} href={d.url}>
                                      {d.label}
                                    </External>
                                  ))}
                                  {s.url && (
                                    <External href={s.url}>
                                      Открыть источник
                                    </External>
                                  )}
                                </div>
                                <p className="limitation">
                                  <Info size={14} />
                                  {s.provider.limitations}
                                </p>
                              </div>
                              {s.provider.group !== "MCP" && (
                                <div className="connection-column">
                                  {s.connection.credentials.length > 0 ? (
                                    <div className="credentials">
                                      {s.connection.credentials.map((c) => (
                                        <div key={c.key}>
                                          <code>{c.key}</code>
                                          <span
                                            className={
                                              c.present
                                                ? "credential-present"
                                                : ""
                                            }
                                          >
                                            {c.present ? (
                                              <>
                                                <Check size={13} />
                                                Задан
                                              </>
                                            ) : (
                                              <>
                                                <KeyRound size={13} />
                                                Не задан
                                              </>
                                            )}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="muted">
                                      API-ключ не требуется
                                    </p>
                                  )}
                                  <p
                                    className={
                                      s.lastError ? "error-text" : "muted"
                                    }
                                  >
                                    {s.connection.message}
                                  </p>
                                  <small>
                                    Последний Sync: {formatTime(s.lastSyncAt)}
                                  </small>
                                  {s.lastResult && (
                                    <>
                                      <Stats result={s.lastResult} />
                                      {s.lastResult.warnings.map((w) => (
                                        <small className="warning-text" key={w}>
                                          {w}
                                        </small>
                                      ))}
                                    </>
                                  )}
                                </div>
                              )}
                              {!!s.provider.mcpTools?.length && (
                                <section className="mcp-tools-panel">
                                  <header>
                                    <span aria-hidden="true">
                                      <Check size={13} />
                                    </span>
                                    <div>
                                      <h3>Доступно модели через MCP</h3>
                                      <p>
                                        Доступен локальный MCP-сервер
                                        {s.provider.mcpServer
                                          ? ` ${s.provider.mcpServer}`
                                          : ""}
                                        . Модель может вызывать следующие
                                        инструменты:
                                      </p>
                                    </div>
                                  </header>
                                  <div className="mcp-tools-list">
                                    {s.provider.mcpTools.map((tool) => (
                                      <div key={tool.name}>
                                        <code>{tool.name}</code>
                                        <span>{tool.description}</span>
                                      </div>
                                    ))}
                                  </div>
                                </section>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ) : null;
          })}
          {!visible.length && (
            <Empty>
              <Plug size={28} />
              <h3>Источники не найдены</h3>
              <p>
                {tab === "other"
                  ? "Для этой географии нет источников в разделе «Другие»."
                  : "Измените поиск или добавьте источник для этой географии."}
              </p>
            </Empty>
          )}
        </>
      )}
      {tab === "discovered" && (
        <>
          <div className="source-help candidate-help">
            <Info size={15} />
            <span>
              Это не события, а новые ссылки на сайты, Telegram, Instagram или
              Facebook, найденные внутри уже загруженных карточек. LLM может
              принять ссылку через API; новый источник создаётся выключенным и
              не запускает обход.
            </span>
          </div>
          {discovered.length ? (
            <div className="candidate-list">
              {discovered.map((c) => (
                <article key={c.id}>
                  <div>
                    <strong>{c.name}</strong>
                    <p>{c.reason}</p>
                    <div className="doc-links">
                      <External href={c.url}>{c.probableType}</External>
                      {c.entityId && (
                        <button
                          className="text-button"
                          onClick={() => onOpen(c.entityId!)}
                        >
                          Открыть запись
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="actions">
                    <Button
                      disabled={!!busy}
                      onClick={() => onCandidate(c.id, "ignore")}
                    >
                      Скрыть
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty>
              <Link size={28} />
              <h3>Новых источников пока нет</h3>
              <p>
                Ссылки на сайты и социальные профили появятся после импорта или
                синхронизации.
              </p>
            </Empty>
          )}
        </>
      )}
      {tab === "history" && (
        <div className="history-list">
          {runs
            .filter((r) => local.some((s) => s.id === r.sourceId))
            .map((r) => (
              <article key={r.id}>
                <div className="history-title">
                  <strong>{r.sourceName}</strong>
                  <span>{formatTime(r.startedAt)}</span>
                  <span
                    className={`badge ${r.status === "error" ? "warning" : ""}`}
                  >
                    {r.status === "success"
                      ? "Завершено"
                      : r.status === "running"
                        ? "В процессе"
                        : r.status === "partial"
                          ? "Частично"
                          : "Ошибка"}
                  </span>
                </div>
                <Stats result={r} />
                {r.error && <p className="error-text">{r.error}</p>}
                {r.warnings.map((w) => (
                  <p className="warning-text" key={w}>
                    {w}
                  </p>
                ))}
              </article>
            ))}
          {!runs.some((r) => local.some((s) => s.id === r.sourceId)) && (
            <Empty>
              <History size={28} />
              <h3>История пуста</h3>
              <p>Здесь будут результаты ручных синхронизаций.</p>
            </Empty>
          )}
        </div>
      )}
    </>
  );
}

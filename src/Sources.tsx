import { useState } from "react";
import {
  Plus,
  RefreshCw,
  Plug,
  ChevronDown,
  Check,
  KeyRound,
  Link,
  Pause,
  Info,
  Search,
  ArrowUpRight,
  History,
  UserRound,
} from "lucide-react";
import type {
  Candidate,
  ProviderInfo,
  Scope,
  SourceView,
  SyncRun,
} from "../shared/model";
import { Button, External, Empty, Stats, Busy } from "./components";
const statusLabels: Record<string, string> = {
  disabled: "Выключен",
  not_configured: "Нужен ключ",
  setup_required: "Нужен адаптер",
  ready: "Готов к проверке",
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
export function Sources({
  sources,
  providers,
  scopes,
  scope,
  candidates,
  runs,
  busy,
  onEdit,
  onAdd,
  onAction,
  onSyncAll,
  onCandidate,
  onOpen,
  onRefresh,
}: {
  sources: SourceView[];
  providers: ProviderInfo[];
  scopes: Scope[];
  scope: Scope;
  candidates: Candidate[];
  runs: SyncRun[];
  busy: string;
  onEdit: (source: SourceView) => void;
  onAdd: () => void;
  onAction: (source: SourceView, action: "test" | "sync") => void;
  onSyncAll: () => void;
  onCandidate: (id: string, action: "accept" | "ignore") => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState("connections"),
    [expanded, setExpanded] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [onlyEnabled, setOnlyEnabled] = useState(false);
  const local = sources.filter((s) => {
    const location = scopes.find((l) => l.id === s.scopeId);
    return (
      location?.country === scope.country &&
      (!scope.city || location?.city === scope.city)
    );
  });
  const visible = local.filter(
    (s) =>
      (!onlyEnabled || s.enabled) &&
      [s.name, s.provider.description, s.url]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const groups = [...new Set(providers.map((p) => p.group))];
  const discovered = candidates.filter(
    (c) => c.status === "new" && (!scope.city || c.scopeId === scope.id),
  );
  return (
    <>
      <div className="page-heading">
        <div className="heading-title">
          <h1>Источники</h1>
          <span className="count">{local.length}</span>
        </div>
        <div className="actions">
          <Button
            disabled={!!busy || !local.some((s) => s.connection.canSync)}
            onClick={onSyncAll}
          >
            {busy === "all" ? <Busy /> : <RefreshCw size={15} />}
            Синхронизировать включённые
          </Button>
          <Button primary onClick={onAdd}>
            <Plus size={16} />
            Источник
          </Button>
        </div>
      </div>
      <div className="type-tabs">
        <button
          className={tab === "connections" ? "selected" : ""}
          onClick={() => setTab("connections")}
        >
          <Plug size={15} />
          Подключения<small>{local.filter((s) => s.enabled).length}</small>
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
      {tab === "connections" && (
        <>
          <div className="filter-bar">
            <label className="search">
              <Search size={17} />
              <input
                aria-label="Поиск источников"
                placeholder="Название или платформа"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={onlyEnabled}
                onChange={(e) => setOnlyEnabled(e.target.checked)}
              />
              Только включённые
            </label>
            <span className="filter-note">Обновление вручную</span>
          </div>
          <div className="source-help">
            <KeyRound size={15} />
            <span>
              Ключи — в <code>.env.local</code>. После изменения обновите
              статусы подключения. Перезапуск не нужен.
            </span>
            <button
              className="text-button refresh-status"
              disabled={!!busy}
              onClick={onRefresh}
            >
              <RefreshCw size={12} />
              Обновить статусы
            </button>
          </div>
          {groups.map((group) => {
            const list = visible.filter((s) => s.provider.group === group);
            return list.length ? (
              <section className="source-group" key={group}>
                <h2>
                  {group}
                  <small>{list.length}</small>
                </h2>
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
                            {s.provider.registration && (
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
                            {s.provider.mode === "manual" && s.enabled
                              ? "Ручной импорт"
                              : statusLabels[s.connection.status]}
                            {!s.provider.implemented &&
                            s.connection.status === "disabled"
                              ? " · заготовка"
                              : ""}
                          </span>
                          <small>
                            {s.itemCount
                              ? `${s.itemCount} записей`
                              : "Нет записей"}{" "}
                            · {scopes.find((l) => l.id === s.scopeId)?.name}
                          </small>
                        </div>
                        <div className="source-row-actions">
                          <Button onClick={() => onEdit(s)}>Настроить</Button>
                          <Button
                            title="Синхронизировать источник"
                            disabled={!!busy || !s.connection.canSync}
                            onClick={() => onAction(s, "sync")}
                          >
                            {busy === s.id ? <Busy /> : <RefreshCw size={15} />}
                          </Button>
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
                        <div className="source-details">
                          <div className="setup-column">
                            <h3>Подключение</h3>
                            <ol>
                              {s.provider.steps.map((step) => (
                                <li key={step}>{step}</li>
                              ))}
                            </ol>
                            <div className="doc-links">
                              {s.provider.registration && (
                                <External href={s.provider.registration.url}>
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
                          <div className="connection-column">
                            {s.connection.credentials.length > 0 ? (
                              <div className="credentials">
                                {s.connection.credentials.map((c) => (
                                  <div key={c.key}>
                                    <code>{c.key}</code>
                                    <span
                                      className={
                                        c.present ? "credential-present" : ""
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
                              <p className="muted">API-ключ не требуется</p>
                            )}
                            <p className={s.lastError ? "error-text" : "muted"}>
                              {s.connection.message}
                            </p>
                            <div className="actions">
                              <Button
                                disabled={!!busy || !s.connection.canTest}
                                onClick={() => onAction(s, "test")}
                              >
                                {busy === s.id ? <Busy /> : <Plug size={14} />}
                                Проверить
                              </Button>
                              <Button
                                primary
                                disabled={!!busy || !s.connection.canSync}
                                onClick={() => onAction(s, "sync")}
                              >
                                <RefreshCw size={14} />
                                Синхронизировать
                              </Button>
                            </div>
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
              <p>Измените поиск или добавьте источник для этой географии.</p>
            </Empty>
          )}
        </>
      )}
      {tab === "discovered" && (
        <>
          <div className="list-caption">
            <span>
              Ссылки из загруженных записей · добавляются выключенными
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
                    <Button
                      disabled={!!busy}
                      primary
                      onClick={() => onCandidate(c.id, "accept")}
                    >
                      <Plus size={14} />В источники
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

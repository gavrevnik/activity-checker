import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Layers,
  Plug,
  CheckCircle2,
  X,
  AlertCircle,
  MapPin,
  UserRound,
} from "lucide-react";
import type {
  Candidate,
  Entity,
  ProviderInfo,
  Scope,
  SourceView,
  SyncRun,
  SyncResult,
  SyncOptions,
  UserProfile,
  UserProfileInput,
  FilteringRules,
  FilteringRulesView,
} from "../shared/model";
import { api } from "./api";
import { Activities } from "./Activities";
import { Sources } from "./Sources";
import { EntityForm, SourceForm } from "./forms";
import { Detail } from "./Detail";
import { Busy } from "./components";
import { SyncConfirmation } from "./SyncConfirmation";
import { Profile } from "./Profile";
import { createEntityStateUpdater } from "./entity-state";
import { saveEntityState } from "./entity-state-api";
interface Data {
  scopes: Scope[];
  providers: ProviderInfo[];
  sources: SourceView[];
  entities: Entity[];
  candidates: Candidate[];
  runs: SyncRun[];
  profile: UserProfile;
  filterRules: FilteringRulesView;
}
export default function App() {
  const [data, setData] = useState<Data | null>(null),
    [tab, setTab] = useState(
      localStorage.getItem("activity-tab") || "activities",
    ),
    [scopeId, setScopeId] = useState(
      localStorage.getItem("activity-scope") || "belgrade",
    ),
    [activityNavigationVersion, setActivityNavigationVersion] = useState(0),
    [form, setForm] = useState<"entity" | "source" | null>(null),
    [editing, setEditing] = useState<Entity>(),
    [source, setSource] = useState<SourceView>(),
    [syncSource, setSyncSource] = useState<SourceView>(),
    [selected, setSelected] = useState(
      location.hash.startsWith("#activity/")
        ? decodeURIComponent(location.hash.slice(10))
        : "",
    ),
    [busy, setBusy] = useState(""),
    [pendingEntityIds, setPendingEntityIds] = useState<ReadonlySet<string>>(
      () => new Set(),
    ),
    [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
      null,
    );
  const refresh = useCallback(async () => {
    const d = await api<Data>("/bootstrap");
    setData(d);
  }, []);
  useEffect(() => {
    refresh().catch((e) => setNotice({ text: e.message, error: true }));
    const handler = () =>
      setSelected(
        location.hash.startsWith("#activity/")
          ? decodeURIComponent(location.hash.slice(10))
          : "",
      );
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, [refresh]);
  useEffect(() => {
    localStorage.setItem("activity-tab", tab);
  }, [tab]);
  useEffect(() => {
    localStorage.setItem("activity-scope", scopeId);
  }, [scopeId]);
  const open = useCallback((id: string) => {
    location.hash = "activity/" + encodeURIComponent(id);
    setSelected(id);
  }, []);
  const closeDetail = () => {
    history.replaceState(null, "", location.pathname + location.search);
    setSelected("");
  };
  const showActivities = () => {
    setTab("activities");
    setActivityNavigationVersion((version) => version + 1);
  };
  const saveFilterRules = useCallback(
    async (rules: FilteringRules) => {
      setBusy("filter-rules");
      setNotice(null);
      try {
        await api("/filter-rules", "PUT", rules);
        await refresh();
      } catch (error) {
        setNotice({ text: (error as Error).message, error: true });
        throw error;
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );
  const action = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setNotice(null);
    try {
      const message = await fn();
      await refresh();
      if (message) setNotice({ text: message, error: false });
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
      await refresh().catch(() => {});
    } finally {
      setBusy("");
    }
  };
  const setEntityState = useMemo(
    () =>
      createEntityStateUpdater({
        save: saveEntityState,
        patch: (id, state) =>
          setData((current) =>
            current
              ? {
                  ...current,
                  entities: current.entities.map((item) =>
                    item.id === id ? { ...item, ...state } : item,
                  ),
                }
              : current,
          ),
        pending: (id, value) => {
          if (value) setNotice(null);
          setPendingEntityIds((current) => {
            const next = new Set(current);
            if (value) next.add(id);
            else next.delete(id);
            return next;
          });
        },
        reportError: (error) =>
          setNotice({ text: (error as Error).message, error: true }),
      }),
    [],
  );
  const executeSource = (
    s: SourceView,
    mode: "test" | "sync",
    options: SyncOptions | Record<string, never> = {},
  ) =>
    action(s.id, async () => {
      const r = await api<SyncResult & { message?: string }>(
        "/sources/" + s.id + "/" + mode,
        "POST",
        options,
      );
      return (
        r.message ||
        `${s.name}: получено ${r.fetched}, новых ${r.created}, обновлено ${r.updated}, повторных ${r.duplicates}, отфильтровано ${r.filtered}, ошибок ${r.errors}. ${r.warnings?.join(" ") || ""}`
      );
    });
  const runSource = (s: SourceView, mode: "test" | "sync") => {
    if (mode === "sync" && s.provider.requiresSyncConfirmation) {
      setSyncSource(s);
      return;
    }
    void executeSource(s, mode);
  };
  const scope = data?.scopes.find((s) => s.id === scopeId) || data?.scopes[0];
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={showActivities}>
          <img src="/favicon.svg" alt="" />
          <span>
            activity<span className="brand-light"> checker</span>
          </span>
        </a>
        <nav aria-label="Основная навигация">
          <button
            className={tab === "activities" ? "active" : ""}
            onClick={showActivities}
          >
            <Layers size={16} />
            Активности
          </button>
          <button
            className={tab === "sources" ? "active" : ""}
            onClick={() => setTab("sources")}
          >
            <Plug size={16} />
            Источники
            {data &&
              data.sources.some(
                (s) =>
                  !s.provider.hiddenFromSources &&
                  s.provider.group !== "Свои источники" &&
                  s.connection.status === "error",
              ) && <i className="nav-alert" />}
          </button>
          <button
            className={tab === "profile" ? "active" : ""}
            onClick={() => setTab("profile")}
          >
            <UserRound size={16} />
            Мой профиль
          </button>
        </nav>
        {tab !== "profile" && (
          <div className="scope-control">
            <MapPin size={15} />
            {data?.scopes.map((s) => (
              <button
                key={s.id}
                className={scope?.id === s.id ? "selected" : ""}
                aria-pressed={scope?.id === s.id}
                onClick={() => setScopeId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </header>
      <main>
        {notice && (
          <div
            className={`notice ${notice.error ? "error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            {notice.error ? (
              <AlertCircle size={18} />
            ) : (
              <CheckCircle2 size={18} />
            )}
            <span>{notice.text}</span>
            <button
              className="icon-button"
              aria-label="Закрыть уведомление"
              onClick={() => setNotice(null)}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {!data || !scope ? (
          <div className="loading">
            <Busy />
            Загрузка локальной базы…
            {notice?.error && (
              <button onClick={() => refresh()}>Повторить</button>
            )}
          </div>
        ) : (
          <>
            {tab === "activities" ? (
              <Activities
                navigationVersion={activityNavigationVersion}
                entities={data.entities}
                sources={data.sources}
                scope={scope}
                onOpen={open}
                onSetState={setEntityState}
                pendingEntityIds={pendingEntityIds}
                archiveBusy={busy === "archive-past"}
                filterRules={data.filterRules}
                rulesBusy={busy === "filter-rules"}
                onSaveRules={saveFilterRules}
                onArchivePast={() =>
                  action("archive-past", async () => {
                    const archived = await api<{
                      archived: number;
                      cutoffDate: string;
                    }>("/entities/archive-past", "POST", {
                      scopeId: scope.id,
                    });
                    return archived.archived
                      ? `В архивную таблицу перенесено событий: ${archived.archived}.`
                      : "Прошедших событий с подтверждённой датой не найдено.";
                  })
                }
              />
            ) : tab === "sources" ? (
              <Sources
                sources={data.sources}
                scopes={data.scopes}
                scope={scope}
                candidates={data.candidates}
                runs={data.runs}
                busy={busy}
                onEdit={(s) => {
                  setSource(s);
                  setForm("source");
                }}
                onAction={runSource}
                onSyncAll={() =>
                  action("all", async () => {
                    const rows = await api<
                      {
                        sourceName: string;
                        error?: string;
                        result?: SyncResult;
                      }[]
                    >("/sync", "POST", { scopeId: scope.id });
                    const fails = rows.filter(
                      (r) => r.error || r.result?.errors,
                    );
                    const confirmationSource = data.sources.find((source) => {
                      const location = data.scopes.find(
                        (candidate) => candidate.id === source.scopeId,
                      );
                      return (
                        source.provider.group === "API Агрегаторы" &&
                        source.provider.requiresSyncConfirmation &&
                        source.connection.canSync &&
                        location?.country === scope.country &&
                        (!scope.city || source.scopeId === scope.id)
                      );
                    });
                    if (confirmationSource) setSyncSource(confirmationSource);
                    if (fails.length)
                      throw new Error(
                        rows
                          .map((r) =>
                            r.error
                              ? `${r.sourceName}: ${r.error}`
                              : `${r.sourceName}: новых ${r.result?.created}, ошибок ${r.result?.errors}`,
                          )
                          .join("\n"),
                      );
                    return `Синхронизировано источников: ${rows.length}. Новых записей: ${rows.reduce((n, r) => n + (r.result?.created || 0), 0)}. Отфильтровано: ${rows.reduce((n, r) => n + (r.result?.filtered || 0), 0)}.`;
                  })
                }
                onCandidate={(id, mode) =>
                  action(id, async () => {
                    await api("/candidates/" + id, "POST", { action: mode });
                    return mode === "accept"
                      ? "Источник добавлен. Откройте его настройки."
                      : "Кандидат скрыт.";
                  })
                }
                onOpen={open}
              />
            ) : (
              <Profile
                profile={data.profile}
                busy={busy === "profile"}
                onSave={(profile: UserProfileInput) =>
                  action("profile", async () => {
                    await api("/profile", "PUT", profile);
                    return "Профиль сохранён в локальной базе.";
                  })
                }
              />
            )}
            {selected && !form && (
              <Detail
                key={selected}
                id={selected}
                entities={data.entities}
                onClose={closeDetail}
                onEdit={(e) => {
                  setEditing(e);
                  setForm("entity");
                }}
                onChanged={refresh}
                onOpen={open}
              />
            )}
            {form === "entity" && (
              <EntityForm
                entity={editing}
                scope={scope}
                onClose={() => setForm(null)}
                onSaved={refresh}
              />
            )}{" "}
            {form === "source" && (
              <SourceForm
                source={source}
                providers={data.providers}
                scopes={data.scopes}
                scope={scope}
                onClose={() => setForm(null)}
                onSaved={refresh}
              />
            )}{" "}
            {syncSource && (
              <SyncConfirmation
                source={syncSource}
                busy={busy === syncSource.id}
                onClose={() => setSyncSource(undefined)}
                onConfirm={(options) => {
                  const selectedSource = syncSource;
                  setSyncSource(undefined);
                  void executeSource(selectedSource, "sync", options);
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

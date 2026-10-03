import { useEffect, useRef, useState, useId } from "react";
import {
  Archive,
  CalendarDays,
  RefreshCw,
  X,
  ArrowUpRight,
} from "lucide-react";
import type { Scope } from "../shared/model";
import { eventDateRangeLabel } from "../shared/dates";
import {
  sortDigests,
  filterDigestItems,
  digestDays,
  digestDayLabel,
  digestTitle,
  type AiDigest,
  type DigestFilters,
} from "../shared/ai-digests";
import { api } from "./api";
import { Button, Busy, Empty, External } from "./components";
import "./ai-digests.css";

export function AiDigestCard({
  digest,
  timeZone,
  onOpen,
}: {
  digest: AiDigest;
  timeZone: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="ai-digest-card"
      onClick={onOpen}
      aria-haspopup="dialog"
    >
      <span className="ai-digest-card-header">
        <strong className="ai-digest-card-title">{digestTitle(digest)}</strong>
        <span className="badge event-date-badge">
          <CalendarDays size={13} />
          {eventDateRangeLabel(digest.startDate, digest.endDate, timeZone)}
        </span>
      </span>
      <span className="ai-digest-request">
        <strong>Запрос:</strong> {digest.requestSummary}
      </span>
      <span className="ai-digest-stats">
        Событий: {digest.items.length} · Источников:{" "}
        {new Set(digest.items.map((item) => item.sourceName)).size}
      </span>
      <span className="ai-digest-card-footer">
        Сохранён{" "}
        {new Date(digest.createdAt).toLocaleString("ru-RU", { timeZone })}
        {digest.archivedAt && " · В архиве"}
        <span>
          Открыть дайджест <ArrowUpRight size={15} />
        </span>
      </span>
    </button>
  );
}

export function AiDigestDetails({
  digest,
  timeZone,
}: {
  digest: AiDigest;
  timeZone: string;
}) {
  const [filters, setFilters] = useState<DigestFilters>({
    from: "",
    to: "",
    minScore: 0,
    tags: [],
  });
  const [dayLimit, setDayLimit] = useState(31);
  const change = (patch: Partial<DigestFilters>) => {
    setFilters((old) => ({ ...old, ...patch }));
    setDayLimit(31);
  };
  const items = filterDigestItems(digest, filters, timeZone);
  const groups = [];
  for (const group of digestDays(digest, items, filters, timeZone)) {
    groups.push(group);
    if (groups.length > dayLimit) break;
  }
  const tags = [...new Set(digest.items.flatMap((item) => item.tags))].sort(
    (a, b) => a.localeCompare(b, "ru"),
  );
  return (
    <>
      <span className="badge event-date-badge">
        <CalendarDays size={13} />
        {eventDateRangeLabel(digest.startDate, digest.endDate, timeZone)}
      </span>
      <p className="ai-digest-request">
        <strong>Запрос:</strong> {digest.requestSummary}
      </p>
      <div className="ai-digest-controls ai-digest-detail-filters">
        <label>
          С даты{" "}
          <input
            type="date"
            aria-label="События с даты"
            min={digest.startDate}
            max={filters.to || digest.endDate}
            value={filters.from}
            onInput={(e) => change({ from: e.currentTarget.value })}
            onChange={(e) => change({ from: e.target.value })}
          />
        </label>
        <label>
          По дату{" "}
          <input
            type="date"
            aria-label="События по дату"
            min={filters.from || digest.startDate}
            max={digest.endDate}
            value={filters.to}
            onInput={(e) => change({ to: e.currentTarget.value })}
            onChange={(e) => change({ to: e.target.value })}
          />
        </label>
        <label>
          AI-score от{" "}
          <select
            aria-label="Минимальный AI-score"
            value={filters.minScore}
            onChange={(e) => change({ minScore: Number(e.target.value) })}
          >
            {Array.from({ length: 21 }, (_, index) => index / 2).map(
              (score) => (
                <option key={score} value={score}>
                  {score === 0 ? "Любой" : score.toLocaleString("ru-RU")}
                </option>
              ),
            )}
          </select>
        </label>
        <Button
          onClick={() => change({ from: "", to: "", minScore: 0, tags: [] })}
        >
          Сбросить фильтры
        </Button>
      </div>
      {tags.length > 0 && (
        <div
          className="ai-digest-tags"
          role="group"
          aria-label="Фильтр по тегам — любой выбранный"
        >
          {tags.map((tag) => (
            <button
              type="button"
              key={tag}
              className="ai-digest-tag"
              aria-pressed={filters.tags.includes(tag)}
              onClick={() =>
                change({
                  tags: filters.tags.includes(tag)
                    ? filters.tags.filter((value) => value !== tag)
                    : [...filters.tags, tag],
                })
              }
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
      <p className="ai-digest-result-count" role="status">
        Уникальных событий: {items.length} из {digest.items.length}
        {filters.tags.length > 1 && " · Любой из выбранных тегов"}
      </p>
      {filters.from && filters.to && filters.from > filters.to && (
        <p role="alert">Дата начала должна быть не позже даты окончания.</p>
      )}
      {!items.length && <p>По выбранным фильтрам событий нет.</p>}
      {groups.slice(0, dayLimit).map(({ day, items: rows }) => (
        <section className="ai-digest-day" key={day}>
          <h3>{digestDayLabel(day)}</h3>
          <div
            className="ai-digest-table-wrap"
            role="region"
            aria-label={`События: ${digestDayLabel(day)}`}
            tabIndex={0}
          >
            <table className="ai-digest-table">
              <caption className="ai-digest-caption">
                События {digestDayLabel(day)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Мероприятие и описание</th>
                  <th scope="col">AI-score</th>
                  <th scope="col">Источник</th>
                  <th scope="col">Дата события</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, index) => (
                  <tr key={index}>
                    <td>
                      <strong className="ai-digest-event-title">
                        <External href={item.eventUrl || item.sourceUrl}>
                          {item.title}
                        </External>
                      </strong>
                      <p className="ai-digest-description">
                        {item.description}
                      </p>
                      {!!item.tags.length && (
                        <span className="ai-digest-event-tags">
                          {item.tags.map((tag) => `#${tag}`).join(" ")}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="badge">
                        {item.aiScore.toLocaleString("ru-RU")} / 10
                      </span>
                    </td>
                    <td>
                      <External href={item.sourceUrl}>
                        {item.sourceName}
                      </External>
                    </td>
                    <td>
                      {eventDateRangeLabel(item.startAt, item.endAt, timeZone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {groups.length > dayLimit && (
        <Button onClick={() => setDayLimit((limit) => limit + 31)}>
          Показать следующие дни
        </Button>
      )}
      {digest.notes && <p className="ai-digest-notes">{digest.notes}</p>}
    </>
  );
}

function AiDigestModal({
  digest,
  timeZone,
  onClose,
}: {
  digest: AiDigest;
  timeZone: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="ai-digest-modal"
      aria-labelledby={titleId}
      onCancel={onClose}
    >
      <header className="ai-digest-modal-header">
        <h2 id={titleId}>{digestTitle(digest)}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть дайджест"
          onClick={onClose}
          autoFocus
        >
          <X size={22} />
        </button>
      </header>
      <div className="ai-digest-modal-content">
        <AiDigestDetails digest={digest} timeZone={timeZone} />
      </div>
    </dialog>
  );
}
export function AiDigests({ scope }: { scope: Scope }) {
  const [selected, setSelected] = useState<AiDigest | null>(null);
  const [digests, setDigests] = useState<AiDigest[]>([]),
    [archived, setArchived] = useState(false),
    [sort, setSort] = useState<"asc" | "desc">("desc"),
    [version, setVersion] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setDigests([]);
    setSelected(null);
    api<{ digests: AiDigest[] }>(
      `/ai-digests?scopeId=${encodeURIComponent(scope.id)}&archived=${archived}`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((data) => {
        if (!abort.signal.aborted) setDigests(data.digests);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [scope.id, archived, version]);
  async function archivePast() {
    setBusy(true);
    setError("");
    try {
      await api("/ai-digests/archive-past", "POST", { scopeId: scope.id });
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ai-digests" aria-label="AI-дайджесты">
      <div className="filter-bar ai-digest-controls">
        <label>
          Показывать{" "}
          <select
            aria-label="Статус дайджестов"
            value={archived ? "archive" : "active"}
            onChange={(e) => setArchived(e.target.value === "archive")}
          >
            <option value="active">Актуальные</option>
            <option value="archive">Архив</option>
          </select>
        </label>
        <label>
          По дате{" "}
          <select
            aria-label="Сортировка дайджестов по дате"
            value={sort}
            onChange={(e) => setSort(e.target.value as "asc" | "desc")}
          >
            <option value="desc">Поздние сначала</option>
            <option value="asc">Ранние сначала</option>
          </select>
        </label>
        <Button
          disabled={loading || busy}
          onClick={() => setVersion((v) => v + 1)}
        >
          <RefreshCw size={15} />
          Обновить
        </Button>
        <Button disabled={busy || loading} onClick={() => void archivePast()}>
          {busy ? <Busy /> : <Archive size={15} />}Архивировать прошедшие
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">
          <Busy /> Загружаем дайджесты…
        </p>
      ) : !error && !digests.length ? (
        <Empty>
          <CalendarDays size={30} />
          <h3>{archived ? "Архив пока пуст" : "Пока нет AI-дайджестов"}</h3>
          <p>
            Попросите дайджест на нужные даты — подборка сохранится здесь вместе
            с ответом в чате.
          </p>
        </Empty>
      ) : (
        sortDigests(digests, sort).map((d) => (
          <AiDigestCard
            key={d.id}
            digest={d}
            timeZone={scope.timezone}
            onOpen={() => setSelected(d)}
          />
        ))
      )}
      {selected && (
        <AiDigestModal
          key={selected.id}
          digest={selected}
          timeZone={scope.timezone}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

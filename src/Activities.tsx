import { useMemo, useState } from "react";
import {
  Search,
  SlidersHorizontal,
  Star,
  ArrowUpRight,
  Plus,
  Upload,
  ArrowDownUp,
  Copy,
  MapPin,
} from "lucide-react";
import {
  categories,
  entityTypes,
  typeLabels,
  type Entity,
  type EntityType,
  type Scope,
  type SourceView,
} from "../shared/model";
import { displayDate, inPeriod, localDay } from "../shared/dates";
import { Button, Empty, TypeIcon, External, audiences } from "./components";
export function Activities({
  entities,
  sources,
  scope,
  onOpen,
  onAdd,
  onImport,
  onStar,
  onRemoveDemo,
}: {
  entities: Entity[];
  sources: SourceView[];
  scope: Scope;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onImport: () => void;
  onStar: (e: Entity) => void;
  onRemoveDemo: () => void;
}) {
  const [type, setType] = useState<EntityType | "all">("all"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [source, setSource] = useState(""),
    [language, setLanguage] = useState(""),
    [audience, setAudience] = useState(""),
    [tag, setTag] = useState(""),
    [state, setState] = useState("active"),
    [period, setPeriod] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [sort, setSort] = useState("default"),
    [favorites, setFavorites] = useState(false),
    [duplicates, setDuplicates] = useState(false),
    [filters, setFilters] = useState(false),
    [page, setPage] = useState(1);
  const scoped = useMemo(
    () =>
      entities.filter(
        (e) =>
          e.country === scope.country && (!scope.city || e.city === scope.city),
      ),
    [entities, scope],
  );
  const types = scoped.filter(
    (e) => state === "all" || (state === "archive" ? e.archived : !e.archived),
  );
  const filtered = scoped.filter(
    (e) =>
      (type === "all" || e.type === type) &&
      (state === "all" || (state === "archive" ? e.archived : !e.archived)) &&
      (!favorites || e.favorite) &&
      (!duplicates || e.duplicateCount > 0) &&
      (!category || e.category === category) &&
      (!source || e.sources.some((s) => s.id === source)) &&
      (!language || e.languages.includes(language)) &&
      (!audience || e.audience === audience) &&
      (!tag ||
        e.tags.some((t) => t.toLowerCase().includes(tag.toLowerCase()))) &&
      (!search ||
        [e.title, e.description, e.venue, e.address, ...e.tags]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (type !== "Event" || !period || inPeriod(e.startAt, period, from, to)),
  );
  filtered.sort((a, b) => {
    if (sort === "name") return a.title.localeCompare(b.title);
    if (sort === "ai") return (b.aiScore ?? -1) - (a.aiScore ?? -1);
    if (sort === "date" || (sort === "default" && type === "Event"))
      return (a.startAt || "9999").localeCompare(b.startAt || "9999");
    if (type === "Community" && sort === "default") {
      const rank = (e: Entity) =>
        e.languages.includes("ru") || e.audience === "russian-speaking"
          ? 0
          : e.audience === "international" || e.languages.includes("en")
            ? 1
            : 2;
      return rank(a) - rank(b) || a.title.localeCompare(b.title);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const effectivePage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / 30)),
  );
  const extraCount = [
    language,
    audience,
    tag,
    state !== "active",
    favorites,
    duplicates,
  ].filter(Boolean).length;
  const reset = () => {
    setSearch("");
    setCategory("");
    setSource("");
    setLanguage("");
    setAudience("");
    setTag("");
    setState("active");
    setPeriod("");
    setFavorites(false);
    setDuplicates(false);
    setPage(1);
  };
  return (
    <>
      <div className="page-heading">
        <div className="heading-title">
          <h1>Активности</h1>
          <span className="count">
            {scoped.filter((e) => !e.archived).length}
          </span>
        </div>
        <div className="actions">
          <Button onClick={onImport}>
            <Upload size={15} />
            Импорт JSON
          </Button>
          <Button primary onClick={onAdd}>
            <Plus size={16} />
            Добавить
          </Button>
        </div>
      </div>
      <div className="type-tabs" aria-label="Тип активности">
        {(["all", ...entityTypes] as const).map((t) => (
          <button
            key={t}
            aria-pressed={type === t}
            className={type === t ? "selected" : ""}
            onClick={() => {
              setType(t);
              setPage(1);
            }}
          >
            {t !== "all" && <TypeIcon type={t} size={15} />}
            <span>{t === "all" ? "Все" : typeLabels[t]}</span>
            <small>
              {types.filter((e) => t === "all" || e.type === t).length}
            </small>
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Поиск активностей"
            placeholder="Название, место или тег"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <select
          aria-label="Категория"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все категории</option>
          {[...new Set([...categories, ...scoped.map((e) => e.category)])].map(
            (c) => (
              <option key={c}>{c}</option>
            ),
          )}
        </select>
        <select
          aria-label="Источник"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все источники</option>
          {sources
            .filter((s) =>
              scoped.some((e) => e.sources.some((x) => x.id === s.id)),
            )
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <Button
          className={filters || extraCount ? "active-filter" : ""}
          onClick={() => setFilters(!filters)}
        >
          <SlidersHorizontal size={15} />
          Фильтры{extraCount > 0 && <small>{extraCount}</small>}
        </Button>
      </div>
      {filters && (
        <div className="expanded-filters">
          <label>
            Язык
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="">Любой</option>
              {[...new Set(scoped.flatMap((e) => e.languages))]
                .sort()
                .map((l) => (
                  <option key={l}>{l}</option>
                ))}
            </select>
          </label>
          <label>
            Аудитория
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="">Любая</option>
              {Object.entries(audiences)
                .filter(([k]) => k !== "all")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Тег
            <input
              placeholder="Например, climbing"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
          </label>
          <label>
            Состояние
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="active">Активные</option>
              <option value="archive">Архив</option>
              <option value="all">Все</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={favorites}
              onChange={(e) => setFavorites(e.target.checked)}
            />
            Избранное
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={duplicates}
              onChange={(e) => setDuplicates(e.target.checked)}
            />
            Возможные дубли
          </label>
          <button className="text-button" onClick={reset}>
            Сбросить
          </button>
        </div>
      )}
      {type === "Event" && (
        <div className="date-filters">
          {[
            ["", "Все даты"],
            ["today", "Сегодня"],
            ["week", "На неделе"],
            ["weekend", "Выходные"],
            ["custom", "Период"],
          ].map(([v, l]) => (
            <button
              key={v}
              className={period === v ? "selected" : ""}
              onClick={() => {
                setPeriod(v);
                setPage(1);
              }}
            >
              {l}
            </button>
          ))}
          {period === "custom" && (
            <>
              <input
                type="text"
                placeholder="YYYY-MM-DD"
                inputMode="numeric"
                aria-label="Дата с"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <span>—</span>
              <input
                type="text"
                placeholder="YYYY-MM-DD"
                inputMode="numeric"
                aria-label="Дата по"
                min={from}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </>
          )}
          <small>Europe/Belgrade</small>
        </div>
      )}
      {scoped.some((e) => e.demo) && (
        <div className="demo-notice">
          <span>
            <span className="badge demo">Демо</span>Примеры карточек ·
            вымышленные активности
          </span>
          <button className="text-button" onClick={onRemoveDemo}>
            Убрать примеры
          </button>
        </div>
      )}
      <div className="list-caption">
        <span>
          {filtered.length} записей
          {type === "Community" && sort === "default"
            ? " · RU → international → local"
            : ""}
        </span>
        <label>
          <ArrowDownUp size={13} />
          <select
            aria-label="Сортировка"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="default">
              {type === "Event"
                ? "По дате события"
                : type === "Community"
                  ? "По аудитории"
                  : "По обновлению"}
            </option>
            <option value="name">По названию</option>
            {type === "Event" && <option value="date">По дате события</option>}
            <option value="ai">По AI score</option>
          </select>
        </label>
      </div>
      <div className="activity-list">
        {filtered
          .slice((effectivePage - 1) * 30, effectivePage * 30)
          .map((e) => (
            <article className="activity-row" key={e.id}>
              <button
                className={`activity-visual ${e.type.toLowerCase()}`}
                onClick={() => onOpen(e.id)}
                aria-label={"Открыть " + e.title}
              >
                {e.imageUrl ? (
                  <img
                    src={e.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(ev) => {
                      ev.currentTarget.style.display = "none";
                    }}
                  />
                ) : e.type === "Event" && e.startAt ? (
                  <>
                    <strong>
                      {displayDate(e.startAt, {
                        day: "2-digit",
                        month: undefined,
                      })}
                    </strong>
                    <small>
                      {displayDate(e.startAt, {
                        day: undefined,
                        month: "short",
                      })}
                    </small>
                  </>
                ) : (
                  <TypeIcon type={e.type} size={25} />
                )}
              </button>
              <div className="activity-main">
                <div className="row-title">
                  <button className="title-button" onClick={() => onOpen(e.id)}>
                    {e.title}
                  </button>
                  {e.demo && <span className="badge demo">Демо</span>}
                  {e.duplicateCount > 0 && (
                    <span className="badge warning" title="Возможный дубликат">
                      <Copy size={11} />
                      Дубль?
                    </span>
                  )}
                  {e.aiScore !== null && (
                    <span className="badge">{e.aiScore}/100</span>
                  )}
                </div>
                <div className="activity-meta">
                  <span>{e.category}</span>
                  {e.type === "Event" ? (
                    <span>
                      {e.startAt
                        ? e.startAt.length === 10
                          ? "Время уточняется"
                          : displayDate(e.startAt, {
                              day: undefined,
                              month: undefined,
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                        : "Дата уточняется"}
                      {e.startAt && localDay(e.startAt) < localDay()
                        ? " · прошло"
                        : ""}
                    </span>
                  ) : (
                    <span>{typeLabels[e.type]}</span>
                  )}
                  {(e.venue || e.city) && (
                    <span>
                      <MapPin size={12} />
                      {e.venue || e.city}
                    </span>
                  )}
                  {e.price && <span>{e.price}</span>}
                  {e.type === "Community" && (
                    <span>
                      {e.languages.join(" / ")}
                      {e.audience !== "all"
                        ? " · " + audiences[e.audience]
                        : ""}
                    </span>
                  )}
                </div>
                {e.description && (
                  <p className="row-description">{e.description}</p>
                )}
                <div className="row-tags">
                  {e.sources.map((s) => (
                    <span className="source-badge" key={s.id}>
                      {s.providerId === "manual" ? "Вручную" : s.name}
                    </span>
                  ))}
                  {e.tags.slice(0, 3).map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                </div>
              </div>
              <div className="row-side">
                <button
                  className={`icon-button favorite ${e.favorite ? "is-favorite" : ""}`}
                  aria-label={
                    e.favorite ? "Убрать из избранного" : "В избранное"
                  }
                  onClick={() => onStar(e)}
                >
                  <Star size={17} fill={e.favorite ? "currentColor" : "none"} />
                </button>
                <External href={e.url || e.website}>Источник</External>
                <button
                  className="row-open"
                  aria-label={"Подробнее: " + e.title}
                  onClick={() => onOpen(e.id)}
                >
                  <ArrowUpRight size={18} />
                </button>
              </div>
            </article>
          ))}
      </div>
      {!filtered.length && (
        <Empty>
          <MapPin size={30} />
          <h3>
            {scoped.length ? "Ничего не найдено" : "Пока нет активностей"}
          </h3>
          <p>
            {scoped.length
              ? "Измените фильтры или сбросьте условия."
              : "Подключите источник, добавьте запись или импортируйте результаты поиска."}
          </p>
          <Button onClick={scoped.length ? reset : onAdd}>
            {scoped.length ? "Сбросить фильтры" : "Добавить активность"}
          </Button>
        </Empty>
      )}
      {filtered.length > 30 && (
        <div className="pagination">
          <Button
            disabled={effectivePage === 1}
            onClick={() => setPage(effectivePage - 1)}
          >
            Назад
          </Button>
          <span>
            {effectivePage} / {Math.ceil(filtered.length / 30)}
          </span>
          <Button
            disabled={effectivePage * 30 >= filtered.length}
            onClick={() => setPage(effectivePage + 1)}
          >
            Далее
          </Button>
        </div>
      )}
    </>
  );
}

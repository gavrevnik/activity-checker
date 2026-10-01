import { useMemo, useState } from "react";
import {
  Search,
  Star,
  ArrowUpRight,
  ArrowDownUp,
  Copy,
  MapPin,
  Archive,
  CalendarDays,
  ShieldCheck,
  UsersRound,
  UtensilsCrossed,
} from "lucide-react";
import {
  typeLabels,
  type Entity,
  type EntityType,
  type FilteringRules as FilteringRulesValue,
  type FilteringRulesView,
  type Scope,
  type SourceView,
} from "../shared/model";
import {
  displayDate,
  eventDateLabel,
  inDateRange,
  inPeriod,
  isPastEvent,
  localDay,
  startsAtOrAfterHour,
} from "../shared/dates";
import { containsSerbianSpecificLetters } from "../shared/text";
import {
  Button,
  Busy,
  Empty,
  TypeIcon,
  External,
  audiences,
} from "./components";
import { FilteringRules } from "./FilteringRules";

type ActivityTab = "Event" | "Place" | "restaurants" | "Community";

function isRestaurant(entity: Entity) {
  return (
    entity.type === "Place" &&
    entity.tags.some((tag) => tag.toLocaleLowerCase() === "restaurant")
  );
}

function matchesTab(entity: Entity, tab: ActivityTab) {
  if (tab === "restaurants") return isRestaurant(entity);
  if (tab === "Place") return entity.type === "Place" && !isRestaurant(entity);
  return entity.type === tab;
}

const activityTabs: ActivityTab[] = [
  "Event",
  "restaurants",
  "Community",
  "Place",
];

function tabLabel(tab: ActivityTab) {
  if (tab === "restaurants") return "Рестораны";
  return typeLabels[tab];
}

function socialReference(entity: Entity) {
  const telegram = entity.knownIds.telegram_username;
  if (telegram)
    return {
      href: entity.url || `https://t.me/${telegram}`,
      label: `@${telegram}`,
    };
  const instagram = entity.knownIds.instagram;
  if (instagram)
    return {
      href: entity.url || `https://www.instagram.com/${instagram}/`,
      label: `@${instagram}`,
    };
  if (entity.knownIds.facebook || entity.tags.includes("facebook"))
    return { href: entity.url || entity.website, label: "Facebook" };
  return null;
}

export function Activities({
  entities,
  sources,
  scope,
  onOpen,
  onStar,
  onArchivePast,
  archiveBusy,
  filterRules,
  rulesBusy,
  onSaveRules,
}: {
  entities: Entity[];
  sources: SourceView[];
  scope: Scope;
  onOpen: (id: string) => void;
  onStar: (e: Entity) => void;
  onArchivePast: () => void;
  archiveBusy: boolean;
  filterRules: FilteringRulesView;
  rulesBusy: boolean;
  onSaveRules: (rules: FilteringRulesValue) => void;
}) {
  const [section, setSection] = useState<"cards" | "rules">("cards"),
    [type, setType] = useState<ActivityTab>("Event"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [source, setSource] = useState(""),
    [language, setLanguage] = useState(""),
    [audience, setAudience] = useState(""),
    [tag, setTag] = useState(""),
    [period, setPeriod] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [startHour, setStartHour] = useState(""),
    [minMembers, setMinMembers] = useState(""),
    [maxMembers, setMaxMembers] = useState(""),
    [sort, setSort] = useState("default"),
    [excludeSerbianLetters, setExcludeSerbianLetters] = useState(true),
    [page, setPage] = useState(1);
  const scoped = useMemo(
    () =>
      entities.filter(
        (e) =>
          !e.demo &&
          e.country === scope.country &&
          (!scope.city || e.city === scope.city),
      ),
    [entities, scope],
  );
  const types = scoped.filter((e) => !e.archived);
  const pastCount = filterRules.pastEventsByScope[scope.id] ?? 0;
  const matches = (
    e: Entity,
    options: { ignoreSource?: boolean; ignoreTag?: boolean } = {},
  ) =>
    matchesTab(e, type) &&
    !e.archived &&
    (!excludeSerbianLetters || !containsSerbianSpecificLetters(e.title)) &&
    (!category || e.category === category) &&
    (options.ignoreSource ||
      !source ||
      e.sources.some((s) => s.id === source)) &&
    (!language || e.languages.includes(language)) &&
    (!audience || e.audience === audience) &&
    (options.ignoreTag || !tag || e.tags.includes(tag)) &&
    (e.type !== "Community" ||
      e.memberCount === null ||
      ((!minMembers || e.memberCount >= Number(minMembers)) &&
        (!maxMembers || e.memberCount <= Number(maxMembers)))) &&
    (!search ||
      [e.title, e.description, e.cuisine, e.venue, e.address, ...e.tags]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase())) &&
    (type !== "Event" ||
      (!period && !from && !to) ||
      (e.type === "Event" &&
        (!period || inPeriod(e.startAt, period)) &&
        ((!from && !to) ||
          inDateRange(e.startAt, e.endAt, from, to, scope.timezone)))) &&
    (type !== "Event" ||
      !startHour ||
      (e.type === "Event" &&
        startsAtOrAfterHour(e.startAt, startHour, scope.timezone)));
  const filtered = scoped.filter((e) => matches(e));
  const counts = (values: string[]) => {
    const result = new Map<string, number>();
    for (const value of values)
      if (value) result.set(value, (result.get(value) || 0) + 1);
    return [...result.entries()].sort(
      ([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b, "ru"),
    );
  };
  const categoryOptions = counts(scoped.map((e) => e.category));
  const languageOptions = counts(scoped.flatMap((e) => e.languages));
  const audienceOptions = counts(
    scoped.map((e) => e.audience).filter((value) => value !== "all"),
  );
  const tagCounts = new Map<string, number>();
  for (const entity of scoped.filter((e) => matches(e, { ignoreTag: true })))
    for (const name of new Set(entity.tags))
      tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
  const tagOptions = [...new Set([...tagCounts.keys(), ...(tag ? [tag] : [])])]
    .map((name) => [name, tagCounts.get(name) || 0] as const)
    .sort(
      ([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b, "ru"),
    );
  const sourceCounts = new Map<string, number>();
  for (const entity of scoped.filter((e) => matches(e, { ignoreSource: true })))
    for (const id of new Set(entity.sources.map((item) => item.id)))
      sourceCounts.set(id, (sourceCounts.get(id) || 0) + 1);
  const sourceOptions = sources.filter(
    (item) => sourceCounts.has(item.id) || item.id === source,
  );
  filtered.sort((a, b) => {
    if (sort === "name") return a.title.localeCompare(b.title);
    if (sort === "ai") return (b.aiScore ?? -1) - (a.aiScore ?? -1);
    if (sort === "members")
      return (b.memberCount ?? -1) - (a.memberCount ?? -1);
    if (sort === "date" || (sort === "default" && type === "Event")) {
      const aDate = a.type === "Event" ? a.startAt || "9999" : "9999";
      const bDate = b.type === "Event" ? b.startAt || "9999" : "9999";
      return aDate.localeCompare(bDate) || a.title.localeCompare(b.title);
    }
    if (type === "Community" && sort === "default") {
      const rank = (e: Entity) =>
        e.languages.includes("ru") || e.audience === "russian-speaking"
          ? 0
          : e.audience === "international" || e.languages.includes("en")
            ? 1
            : 2;
      return rank(a) - rank(b) || a.title.localeCompare(b.title);
    }
    if (type === "restaurants" && sort === "default") {
      const closed = (e: Entity) =>
        e.tags.includes("closed-permanently") ? 1 : 0;
      return (
        closed(a) - closed(b) ||
        (b.googleRating ?? -1) - (a.googleRating ?? -1) ||
        (b.googleReviewCount ?? -1) - (a.googleReviewCount ?? -1) ||
        a.title.localeCompare(b.title)
      );
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const effectivePage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / 30)),
  );
  const reset = () => {
    setSearch("");
    setCategory("");
    setSource("");
    setLanguage("");
    setAudience("");
    setTag("");
    setPeriod("");
    setFrom("");
    setTo("");
    setStartHour("");
    setMinMembers("");
    setMaxMembers("");
    setExcludeSerbianLetters(true);
    setPage(1);
  };
  const headingActions = (
    <div className="actions activity-heading-actions">
      <Button
        disabled={!pastCount || archiveBusy}
        title={
          pastCount
            ? `Перенести в отдельную таблицу: ${pastCount}`
            : "Прошедших событий с датой нет"
        }
        onClick={() => {
          if (
            window.confirm(
              `Перенести ${pastCount} прошедших событий в архивную таблицу? Они исчезнут из списка активностей.`,
            )
          )
            onArchivePast();
        }}
      >
        {archiveBusy ? <Busy /> : <Archive size={15} />}
        Архивировать прошлые события
        {pastCount > 0 && <small>{pastCount}</small>}
      </Button>
      <Button
        className={section === "rules" ? "active-filter" : ""}
        onClick={() => setSection(section === "rules" ? "cards" : "rules")}
      >
        <ShieldCheck size={15} />
        Правила фильтрации
        <small>{filterRules.counts.total}</small>
      </Button>
    </div>
  );
  if (section === "rules")
    return (
      <>
        <div className="page-heading">
          <div className="heading-title">
            <h1>Активности</h1>
            <span className="count">
              {scoped.filter((e) => !e.archived).length}
            </span>
          </div>
          {headingActions}
        </div>
        <FilteringRules
          value={filterRules}
          busy={rulesBusy}
          onSave={onSaveRules}
        />
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div className="heading-title">
          <h1>Активности</h1>
          <span className="count">
            {scoped.filter((e) => !e.archived).length}
          </span>
        </div>
        {headingActions}
      </div>
      <div className="type-tabs" aria-label="Тип активности">
        {activityTabs.map((t) => (
          <button
            key={t}
            aria-pressed={type === t}
            className={type === t ? "selected" : ""}
            onClick={() => {
              setSection("cards");
              setType(t);
              setPage(1);
            }}
          >
            {t === "restaurants" ? (
              <UtensilsCrossed size={15} />
            ) : (
              <TypeIcon type={t} size={15} />
            )}
            <span>{tabLabel(t)}</span>
            <small>{types.filter((e) => matchesTab(e, t)).length}</small>
          </button>
        ))}
      </div>
      <div className="filter-bar activity-filter-bar">
        <div className="activity-search-block">
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
          <label
            className="serbian-title-filter"
            title="Č, Ć, Đ, Š, Ž и сербские кириллические Ј, Љ, Њ, Ћ, Ђ, Џ. Латинская J не учитывается."
          >
            <input
              type="checkbox"
              checked={excludeSerbianLetters}
              onChange={(event) => {
                setExcludeSerbianLetters(event.target.checked);
                setPage(1);
              }}
            />
            Название не содержит сербские буквы
          </label>
        </div>
        <select
          aria-label="Категория"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все категории</option>
          {categoryOptions.map(([name, count]) => (
            <option key={name} value={name}>
              {name} ({count})
            </option>
          ))}
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
          {sourceOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({sourceCounts.get(item.id) || 0})
            </option>
          ))}
        </select>
        <select
          aria-label="Тег"
          value={tag}
          onChange={(e) => {
            setTag(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Все теги</option>
          {tagOptions.map(([name, count]) => (
            <option key={name} value={name}>
              #{name} ({count})
            </option>
          ))}
        </select>
      </div>
      <div className="expanded-filters">
        {languageOptions.length > 0 && (
          <label>
            Язык
            <select
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Любой</option>
              {languageOptions.map(([name, count]) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </select>
          </label>
        )}
        {audienceOptions.length > 0 && (
          <label>
            Аудитория
            <select
              value={audience}
              onChange={(e) => {
                setAudience(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Любая</option>
              {audienceOptions.map(([name, count]) => (
                <option key={name} value={name}>
                  {audiences[name as keyof typeof audiences]} ({count})
                </option>
              ))}
            </select>
          </label>
        )}
        {type === "Community" && (
          <>
            <label>
              Участников от
              <input
                type="number"
                min="0"
                placeholder="Любое"
                value={minMembers}
                onChange={(event) => {
                  setMinMembers(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label>
              Участников до
              <input
                type="number"
                min="0"
                placeholder="Любое"
                value={maxMembers}
                onChange={(event) => {
                  setMaxMembers(event.target.value);
                  setPage(1);
                }}
              />
            </label>
          </>
        )}
        {type === "Event" && (
          <>
            <label>
              Событие с
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPeriod("");
                  setPage(1);
                }}
              />
            </label>
            <label>
              Событие по
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPeriod("");
                  setPage(1);
                }}
              />
            </label>
            <label>
              Начало в
              <input
                type="number"
                min="0"
                max="23"
                step="1"
                inputMode="numeric"
                placeholder="Час"
                value={startHour}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "" ||
                    (/^\d{1,2}$/.test(value) && Number(value) <= 23)
                  ) {
                    setStartHour(value);
                  }
                  setPage(1);
                }}
              />
            </label>
          </>
        )}
        <button className="text-button" onClick={reset}>
          Сбросить
        </button>
      </div>
      {type === "Event" && (
        <div className="date-filters">
          {[
            ["", "Все даты"],
            ["today", "Сегодня"],
            ["week", "На неделе"],
            ["two-weeks", "Эта и следующая неделя"],
            ["weekend", "Выходные"],
          ].map(([v, l]) => (
            <button
              key={v}
              className={period === v ? "selected" : ""}
              onClick={() => {
                setPeriod(v);
                setFrom("");
                setTo("");
                setPage(1);
              }}
            >
              {l}
            </button>
          ))}
          <small>{scope.timezone}</small>
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
                  : type === "restaurants"
                    ? "По рейтингу"
                    : "По обновлению"}
            </option>
            <option value="name">По названию</option>
            <option value="date">По дате события</option>
            <option value="members">По размеру сообщества</option>
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
                  {e.type === "Event" && e.startAt && (
                    <span className="badge event-date-badge">
                      <CalendarDays size={11} />
                      {eventDateLabel(e.startAt, scope.timezone)}
                    </span>
                  )}
                  {e.duplicateCount > 0 && (
                    <span className="badge warning" title="Возможный дубликат">
                      <Copy size={11} />
                      Дубль?
                    </span>
                  )}
                  {e.aiScore !== null && (
                    <span className="badge">{e.aiScore}/100</span>
                  )}
                  {e.type === "Place" && e.googleRating !== null && (
                    <span className="badge">
                      ★ {e.googleRating}
                      {e.googleReviewCount !== null
                        ? ` · ${e.googleReviewCount.toLocaleString("ru-RU")}`
                        : ""}
                    </span>
                  )}
                  {isRestaurant(e) && e.tags.includes("closed-permanently") && (
                    <span className="badge danger">Закрыто навсегда</span>
                  )}
                </div>
                <div className="activity-meta">
                  <span>
                    {isRestaurant(e) && e.cuisine ? e.cuisine : e.category}
                  </span>
                  {e.type === "Event" ? (
                    isPastEvent(
                      e.startAt,
                      e.endAt,
                      localDay(),
                      scope.timezone,
                    ) ? (
                      <span>прошло</span>
                    ) : null
                  ) : (
                    <span>
                      {isRestaurant(e) ? "Ресторан" : typeLabels[e.type]}
                    </span>
                  )}
                  {isRestaurant(e) && (e.address || e.venue || e.city) ? (
                    <span>
                      <a
                        className="restaurant-address"
                        href={
                          e.url ||
                          e.website ||
                          `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                            e.address || e.venue || e.city,
                          )}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        <MapPin size={12} />
                        {e.address || e.venue || e.city}
                      </a>
                    </span>
                  ) : (
                    (e.venue || e.city) && (
                      <span>
                        <MapPin size={12} />
                        {e.venue || e.city}
                      </span>
                    )
                  )}
                  {e.price && <span>{e.price}</span>}
                  {e.type === "Community" && (
                    <>
                      <span>
                        {e.languages.join(" / ")}
                        {e.audience !== "all"
                          ? " · " + audiences[e.audience]
                          : ""}
                      </span>
                      <span>
                        <UsersRound size={12} />
                        {e.memberCount === null
                          ? "Размер неизвестен"
                          : `${e.memberCount.toLocaleString("ru-RU")} участников`}
                      </span>
                    </>
                  )}
                </div>
                {e.description && (
                  <p className="row-description">{e.description}</p>
                )}
                <div className="row-tags">
                  {socialReference(e) && (
                    <External href={socialReference(e)!.href}>
                      {socialReference(e)!.label}
                    </External>
                  )}
                  {e.sources.map((s) => (
                    <span className="source-badge" key={s.id}>
                      {s.providerId === "manual" ? "Вручную" : s.name}
                    </span>
                  ))}
                  {e.tags
                    .filter(
                      (t) =>
                        !isRestaurant(e) ||
                        !["restaurant", "closed-permanently"].includes(t),
                    )
                    .slice(0, 3)
                    .map((t) => (
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
                <External href={e.url || e.website}>
                  {isRestaurant(e) ? "Google Maps" : "Источник"}
                </External>
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
              : "Подключите источник или добавьте результаты через LLM."}
          </p>
          {scoped.length > 0 && (
            <Button onClick={reset}>Сбросить фильтры</Button>
          )}
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

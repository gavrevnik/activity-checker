import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Search,
  Star,
  RotateCcw,
  ArrowUpRight,
  ArrowDownUp,
  Copy,
  MapPin,
  Archive,
  CalendarDays,
  ShieldCheck,
  UsersRound,
  UtensilsCrossed,
  Send,
  Clock,
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
import { localDay, periodDateRange } from "../shared/dates";
import {
  Button,
  Busy,
  CheckboxMultiSelect,
  Empty,
  TypeIcon,
  External,
  audiences,
} from "./components";
import { FilteringRules } from "./FilteringRules";
import { type SetEntityState } from "./entity-state";
import { TelegramEvents } from "./TelegramEvents";
import { isTelegramCommunity } from "../shared/telegram-monitoring";
import { api } from "./api";
import { EventReactions } from "./EventReactions";
import { matchesEvaluation } from "../shared/personal-state";
import { DateRangeFilter } from "./DateRangeFilter";
import { quickDatePeriods } from "./date-range-calendar";
import { isAiScoreInput, matchesAiScore } from "../shared/score-filter";
import { useRetainedFeedbackCards } from "./DislikeFeedback";
import { feedbackCardKey } from "./feedback-retention";
import { matchesExcursionsTag } from "../shared/excursions-filter";
import { AiDigests } from "./AiDigests";

type ActivityTab =
  "Event" | "Place" | "restaurants" | "Community" | "telegram" | "tg-channels" | "digests";

function isRestaurant(entity: Entity) {
  return entity.presentation.isRestaurant;
}

function matchesTab(entity: Entity, tab: ActivityTab) {
  if (tab === "restaurants") return isRestaurant(entity);
  if (tab === "Place") return entity.type === "Place" && !isRestaurant(entity);
  if (tab === "tg-channels") return isTelegramCommunity(entity);
  if (tab === "Community")
    return entity.type === "Community" && !isTelegramCommunity(entity);
  return entity.type === tab;
}

const activityTabs: ActivityTab[] = [
  "Event",
  "restaurants",
  "Community",
  "tg-channels",
  "telegram",
  "Place",
  "digests",
];

function tabLabel(tab: ActivityTab) {
  if (tab === "digests") return "AI-дайджесты";
  if (tab === "telegram") return "Посты";
  if (tab === "tg-channels") return "Каналы";
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

function FavoriteButton({
  entity,
  onSetState,
  pending,
}: {
  entity: Entity;
  onSetState: SetEntityState;
  pending: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  const update = async () => {
    if (pressed || pending) return;
    setPressed(true);
    try {
      await onSetState(entity, { favorite: !entity.favorite });
    } finally {
      setPressed(false);
    }
  };
  return (
    <button
      className={`icon-button favorite ${entity.favorite ? "is-favorite" : ""} ${pressed ? "is-confirming" : ""}`}
      aria-label={entity.favorite ? "Убрать из избранного" : "В избранное"}
      disabled={pressed || pending}
      onClick={() => void update()}
    >
      <Star size={17} fill={entity.favorite ? "currentColor" : "none"} />
    </button>
  );
}

const ActivityRow = memo(function ActivityRow({
  entity: e,
  today,
  evaluation,
  pending,
  onOpen,
  onSetState,
}: {
  entity: Entity;
  today: string;
  evaluation: string[] | null;
  pending: boolean;
  onOpen: (id: string) => void;
  onSetState: SetEntityState;
}) {
  const [exiting, setExiting] = useState(false);
  return (
    <article
      className={`activity-row ${pending ? "action-pending" : ""} ${exiting ? "action-exiting" : ""}`}
      aria-busy={pending || undefined}
      inert={pending || exiting}
      key={e.id}
    >
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
            <strong>{e.presentation.dayNumber}</strong>
            <small>{e.presentation.monthLabel}</small>
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
              {e.presentation.dateLabel}
            </span>
          )}
          {e.duplicateCount > 0 && (
            <span className="badge warning" title="Возможный дубликат">
              <Copy size={11} />
              Дубль?
            </span>
          )}
          {e.aiScore !== null && (
            <span className="badge">AI {e.aiScore}/10</span>
          )}
          {e.type === "Place" && e.googleRating !== null && (
            <span className="badge">
              ★ {e.googleRating}
              {e.googleReviewCount !== null
                ? ` · ${e.presentation.googleReviewCountLabel}`
                : ""}
            </span>
          )}
          {isRestaurant(e) && e.tags.includes("closed-permanently") && (
            <span className="badge danger">Закрыто навсегда</span>
          )}
        </div>
        <div className="activity-meta">
          <span>{isRestaurant(e) && e.cuisine ? e.cuisine : e.category}</span>
          {e.type === "Event" ? (
            e.presentation.endDay && e.presentation.endDay < today ? (
              <span>прошло</span>
            ) : null
          ) : (
            <span>{isRestaurant(e) ? "Ресторан" : typeLabels[e.type]}</span>
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
                {e.audience !== "all" ? " · " + audiences[e.audience] : ""}
              </span>
              <span>
                <UsersRound size={12} />
                {e.presentation.memberCountLabel}
              </span>
            </>
          )}
        </div>
        {e.description && <p className="row-description">{e.description}</p>}
        {e.reaction === "dislike" && e.dislikeReason && (
          <p className="dislike-reason">Причина: {e.dislikeReason}</p>
        )}
        {e.skipped && e.skipReason && (
          <p className="skip-reason">Причина пропуска: {e.skipReason}</p>
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
              (tag) =>
                !isRestaurant(e) ||
                !["restaurant", "closed-permanently"].includes(tag),
            )
            .slice(0, 3)
            .map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
        </div>
      </div>
      <div className="row-side">
        {e.type === "Event" ? (
          <EventReactions
            entity={e}
            pending={pending}
            onSetState={onSetState}
            willHide={(state) =>
              !matchesEvaluation({ ...e, ...state }, evaluation)
            }
            onExitChange={setExiting}
          />
        ) : (
          <FavoriteButton
            entity={e}
            pending={pending}
            onSetState={onSetState}
          />
        )}
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
  );
});

function ActivityFeed({
  entities,
  pendingEntityIds,
  ...rowProps
}: {
  entities: Entity[];
  pendingEntityIds: ReadonlySet<string>;
  today: string;
  evaluation: string[] | null;
  onOpen: (id: string) => void;
  onSetState: SetEntityState;
}) {
  const [visibleCount, setVisibleCount] = useState(40);
  const sentinel = useRef<HTMLDivElement>(null);
  const previousScroll = useRef<number | null>(null);
  const hasMore = visibleCount < entities.length;
  const loadMore = useCallback(() => {
    previousScroll.current = window.scrollY;
    setVisibleCount((count) => count + 40);
  }, []);
  // Reset a changed filter's feed before observing its tail. Otherwise an old
  // bottom scroll position can immediately expand the entire new result set.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  useLayoutEffect(() => {
    if (previousScroll.current === null) return;
    window.scrollTo({ top: previousScroll.current, behavior: "instant" });
    previousScroll.current = null;
  }, [visibleCount]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, visibleCount, loadMore, entities.length]);
  return (
    <div className="activity-feed">
      <div className="activity-list">
        {entities.slice(0, visibleCount).map((entity) => (
          <ActivityRow
            key={entity.id}
            entity={entity}
            pending={pendingEntityIds.has(entity.id)}
            {...rowProps}
          />
        ))}
      </div>
      {hasMore && (
        <div className="activity-feed-more" ref={sentinel}>
          <button
            className="button"
            onClick={(event) => {
              if (event.detail) event.currentTarget.blur();
              loadMore();
            }}
          >
            Показать ещё
          </button>
          <small>
            Показано {Math.min(visibleCount, entities.length)} из{" "}
            {entities.length}
          </small>
        </div>
      )}
    </div>
  );
}
export function Activities({
  navigationVersion = 0,
  entities,
  sources,
  scope,
  onOpen,
  onSetState,
  pendingEntityIds,
  onArchivePast,
  archiveBusy,
  filterRules,
  rulesBusy,
  onSaveRules,
}: {
  navigationVersion?: number;
  entities: Entity[];
  sources: SourceView[];
  scope: Scope;
  onOpen: (id: string) => void;
  onSetState: SetEntityState;
  pendingEntityIds: ReadonlySet<string>;
  onArchivePast: () => void;
  archiveBusy: boolean;
  filterRules: FilteringRulesView;
  rulesBusy: boolean;
  onSaveRules: (rules: FilteringRulesValue) => Promise<void>;
}) {
  const [section, setSection] = useState<"cards" | "rules">("cards"),
    [type, setType] = useState<ActivityTab>("Event"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [selectedSources, setSelectedSources] = useState<string[] | null>(null),
    [language, setLanguage] = useState(""),
    [audience, setAudience] = useState(""),
    [selectedTags, setSelectedTags] = useState<string[] | null>(null),
    [evaluation, setEvaluation] = useState<string[] | null>(["unrated"]),
    [favoritesOnly, setFavoritesOnly] = useState(false),
    [period, setPeriod] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [startHour, setStartHour] = useState(""),
    [minAiScore, setMinAiScore] = useState(""),
    [minMembers, setMinMembers] = useState(""),
    [maxMembers, setMaxMembers] = useState(""),
    [sort, setSort] = useState("default"),
    [excludeSerbianLetters, setExcludeSerbianLetters] = useState(true),
    [onlyExcursions, setOnlyExcursions] = useState(false);
  useEffect(() => setSection("cards"), [navigationVersion]);
  const retainedFeedbackCards = useRetainedFeedbackCards();
  const selectDatePeriod = useCallback((value: string) => {
    setPeriod(value);
    setFrom("");
    setTo("");
  }, []);
  const serbianTitleFilter = (
    <label
      className="serbian-title-filter"
      title="Исключать названия с сербскими буквами: Č, Ć, Đ, Š, Ž и кириллические Ј, Љ, Њ, Ћ, Ђ, Џ. Латинская J не учитывается."
    >
      <input
        type="checkbox"
        checked={excludeSerbianLetters}
        onChange={(event) => setExcludeSerbianLetters(event.target.checked)}
      />
      не сербское название
    </label>
  );
  const excursionsFilter = (
    <label
      className="excursions-tag-filter"
      title="Показывать только карточки с тегом #Экскурсии"
    >
      <input
        type="checkbox"
        checked={onlyExcursions}
        onChange={(event) => setOnlyExcursions(event.target.checked)}
      />
      #Экскурсии
    </label>
  );
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
  const types = useMemo(() => scoped.filter((e) => !e.archived), [scoped]);
  const [telegramCount, setTelegramCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTelegramCount(null);
    api<{ count: number }>(
      `/telegram-events/count?scopeId=${encodeURIComponent(scope.id)}`,
    )
      .then(({ count }) => {
        if (!cancelled) setTelegramCount(count);
      })
      .catch(() => {
        /* Do not present an unavailable count as zero. */
      });
    return () => {
      cancelled = true;
    };
  }, [scope.id]);
  const pastCount = filterRules.pastEventsByScope[scope.id] ?? 0;
  const normalizedSearch = search.toLowerCase();
  const today = localDay(new Date(), scope.timezone);
  const periodRange = useMemo(
    () => periodDateRange(period, today),
    [period, today],
  );
  const effectiveEvaluation = useMemo(
    () => (favoritesOnly ? ["favorite"] : evaluation),
    [favoritesOnly, evaluation],
  );
  const favoritesActive =
    favoritesOnly ||
    (type === "Event" &&
      evaluation?.length === 1 &&
      evaluation[0] === "favorite");
  const toggleFavorites = () => {
    if (favoritesActive) {
      setFavoritesOnly(false);
      if (!favoritesOnly) setEvaluation(null);
    } else setFavoritesOnly(true);
  };
  const matches = useCallback(
    (
      e: Entity,
      options: {
        ignoreSource?: boolean;
        ignoreTag?: boolean;
        ignoreEvaluation?: boolean;
      } = {},
    ) =>
      matchesTab(e, type) &&
      !e.archived &&
      (!excludeSerbianLetters || !e.presentation.hasSerbianTitle) &&
      matchesExcursionsTag(e.tags, onlyExcursions) &&
      (!category || e.category === category) &&
      (options.ignoreSource ||
        selectedSources === null ||
        e.sources.some((s) => selectedSources.includes(s.id))) &&
      (!language || e.languages.includes(language)) &&
      (!audience || e.audience === audience) &&
      (options.ignoreTag ||
        selectedTags === null ||
        e.tags.some((tag) => selectedTags.includes(tag))) &&
      (options.ignoreEvaluation ||
        retainedFeedbackCards.has(feedbackCardKey("entities", e.id)) ||
        (favoritesOnly
          ? e.favorite
          : type !== "Event" || matchesEvaluation(e, evaluation))) &&
      (e.type !== "Community" ||
        e.memberCount === null ||
        ((!minMembers || e.memberCount >= Number(minMembers)) &&
          (!maxMembers || e.memberCount <= Number(maxMembers)))) &&
      (!normalizedSearch ||
        e.presentation.searchText.includes(normalizedSearch)) &&
      (type !== "Event" || matchesAiScore(e.aiScore, minAiScore)) &&
      (type !== "Event" ||
        (!period && !from && !to) ||
        (e.type === "Event" &&
          (!period ||
            (e.presentation.startDay &&
              (!periodRange.from ||
                e.presentation.startDay >= periodRange.from) &&
              (!periodRange.to ||
                e.presentation.startDay <= periodRange.to))) &&
          ((!from && !to) ||
            (e.presentation.startDay &&
              (!from || e.presentation.endDay >= from) &&
              (!to || e.presentation.startDay <= to))))) &&
      (type !== "Event" ||
        !startHour ||
        (e.type === "Event" &&
          e.presentation.startHour !== null &&
          e.presentation.startHour >= Number(startHour))),
    [
      type,
      excludeSerbianLetters,
      onlyExcursions,
      category,
      selectedSources,
      language,
      audience,
      selectedTags,
      evaluation,
      favoritesOnly,
      minMembers,
      maxMembers,
      normalizedSearch,
      period,
      periodRange,
      from,
      to,
      startHour,
      minAiScore,
      retainedFeedbackCards,
    ],
  );
  const {
    filtered,
    categoryOptions,
    languageOptions,
    audienceOptions,
    tagOptions,
    sourceCounts,
    sourceOptions,
    evaluationOptions,
  } = useMemo(() => {
    const filtered = scoped.filter((e) => matches(e));
    const counts = (values: string[]) => {
      const result = new Map<string, number>();
      for (const value of values)
        if (value) result.set(value, (result.get(value) || 0) + 1);
      return [...result.entries()].sort(
        ([a, aCount], [b, bCount]) =>
          bCount - aCount || a.localeCompare(b, "ru"),
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
    const tagOptions = [
      ...new Set([...tagCounts.keys(), ...(selectedTags || [])]),
    ]
      .map((name) => [name, tagCounts.get(name) || 0] as const)
      .sort(
        ([a, aCount], [b, bCount]) =>
          bCount - aCount || a.localeCompare(b, "ru"),
      );
    const sourceCounts = new Map<string, number>();
    for (const entity of scoped.filter((e) =>
      matches(e, { ignoreSource: true }),
    ))
      for (const id of new Set(entity.sources.map((item) => item.id)))
        sourceCounts.set(id, (sourceCounts.get(id) || 0) + 1);
    const sourceOptions = sources.filter(
      (item) => sourceCounts.has(item.id) || selectedSources?.includes(item.id),
    );
    const evaluationCounts = {
      liked: 0,
      disliked: 0,
      skipped: 0,
      favorite: 0,
      unrated: 0,
    };
    for (const entity of scoped) {
      if (!matches(entity, { ignoreEvaluation: true })) continue;
      if (entity.reaction === "like") evaluationCounts.liked += 1;
      if (entity.reaction === "dislike") evaluationCounts.disliked += 1;
      if (entity.skipped) evaluationCounts.skipped += 1;
      if (entity.favorite) evaluationCounts.favorite += 1;
      if (matchesEvaluation(entity, ["unrated"])) evaluationCounts.unrated += 1;
    }
    const evaluationOptions = [
      ["liked", "Понравилось"],
      ["disliked", "Не понравилось"],
      ["skipped", "Пропущено"],
      ["favorite", "Избранное"],
      ["unrated", "Не оценено"],
    ].map(([value, label]) => ({
      value,
      label,
      count: evaluationCounts[value as keyof typeof evaluationCounts],
    }));
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
      if (
        (type === "Community" || type === "tg-channels") &&
        sort === "default"
      ) {
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
    return {
      filtered,
      categoryOptions,
      languageOptions,
      audienceOptions,
      tagOptions,
      sourceCounts,
      sourceOptions,
      evaluationOptions,
    };
  }, [scoped, matches, selectedTags, selectedSources, sources, sort, type]);
  const reset = () => {
    setSearch("");
    setCategory("");
    setSelectedSources(null);
    setLanguage("");
    setAudience("");
    setSelectedTags(null);
    setEvaluation(null);
    setFavoritesOnly(false);
    setPeriod("");
    setFrom("");
    setTo("");
    setStartHour("");
    setMinAiScore("");
    setMinMembers("");
    setMaxMembers("");
    setExcludeSerbianLetters(false);
    setOnlyExcursions(false);
    setSort("default");
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
            }}
          >
            {t === "digests" ? <CalendarDays size={15} /> : t === "telegram" || t === "tg-channels" ? (
              <Send size={15} />
            ) : t === "restaurants" ? (
              <UtensilsCrossed size={15} />
            ) : (
              <TypeIcon type={t} size={15} />
            )}
            <span>{tabLabel(t)}</span>
            {t !== "digests" && <small>
              {t === "telegram"
                ? (telegramCount ?? "…")
                : types.filter((e) => matchesTab(e, t)).length}
            </small>}
          </button>
        ))}
      </div>
      {type === "digests" ? <AiDigests key={scope.id} scope={scope} /> : type === "telegram" ? (
        <TelegramEvents scope={scope} onCountChange={setTelegramCount} />
      ) : (
        <>
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
                  }}
                />
              </label>
              {type !== "Event" && (
                <div className="activity-search-options">
                  {serbianTitleFilter}
                  {excursionsFilter}
                </div>
              )}
            </div>
            <select
              aria-label="Категория"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
              }}
            >
              <option value="">Все категории</option>
              {categoryOptions.map(([name, count]) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </select>
            <CheckboxMultiSelect
              label="Источники"
              allLabel="Все источники"
              options={sourceOptions.map((item) => ({
                value: item.id,
                label: item.name,
                count: sourceCounts.get(item.id) || 0,
              }))}
              value={selectedSources}
              onChange={(value) => {
                setSelectedSources(value);
              }}
            />
            <div className="activity-tags-controls">
              <CheckboxMultiSelect
                label="Теги"
                allLabel="Все теги"
                options={tagOptions.map(([name, count]) => ({
                  value: name,
                  label: `#${name}`,
                  count,
                }))}
                value={selectedTags}
                onChange={(value) => {
                  setSelectedTags(value);
                }}
              />
              <button
                type="button"
                className="icon-button filter-reset"
                aria-label="Сбросить фильтры"
                title="Сбросить фильтры"
                onClick={reset}
              >
                <RotateCcw size={16} />
              </button>
            </div>
            {type === "Event" && (
              <div className="activity-search-options activity-event-date-options">
                <CheckboxMultiSelect
                  label="Оценка"
                  allLabel="Все оценки"
                  options={evaluationOptions}
                  value={effectiveEvaluation}
                  onChange={(value) => {
                    setFavoritesOnly(false);
                    setEvaluation(value);
                  }}
                />
                <DateRangeFilter
                  from={from || periodRange.from}
                  to={to || periodRange.to}
                  today={today}
                  period={period}
                  onRange={(start, end) => {
                    setFrom(start);
                    setTo(end);
                    setPeriod("");
                  }}
                  onPeriod={selectDatePeriod}
                />
                <label
                  className="activity-start-hour"
                  title="Минимальный час начала от 0 до 23"
                >
                  <Clock size={14} aria-hidden="true" />
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Минимальный час начала от 0 до 23"
                    placeholder="—"
                    value={startHour}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        value === "" ||
                        (/^\d{1,2}$/.test(value) && Number(value) <= 23)
                      ) {
                        setStartHour(value);
                      }
                    }}
                  />
                </label>
                <div
                  className="activity-date-chips"
                  role="group"
                  aria-label="Быстрые периоды событий"
                >
                  {quickDatePeriods.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={period === value}
                      onClick={() => selectDatePeriod(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="activity-ai-score-filter">
                  AI Score
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Минимальный AI Score от 0 до 10"
                    title="Оценка не ниже введённого числа (0–10). Пустое поле — без ограничения."
                    value={minAiScore}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (isAiScoreInput(value)) setMinAiScore(value);
                    }}
                  />
                </label>
                {serbianTitleFilter}
                {excursionsFilter}
              </div>
            )}
          </div>
          <div
            className={
              type === "Event"
                ? "activity-secondary-filters"
                : "expanded-filters"
            }
          >
            {languageOptions.length > 0 && (
              <label>
                Язык
                <select
                  value={language}
                  onChange={(e) => {
                    setLanguage(e.target.value);
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
            {(type === "Community" || type === "tg-channels") && (
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
                    }}
                  />
                </label>
              </>
            )}
          </div>
          <div className="list-caption">
            <span>
              {filtered.length} записей
              {(type === "Community" || type === "tg-channels") &&
              sort === "default"
                ? " · RU → international → local"
                : ""}
            </span>
            <div className="activity-list-tools">
              <div className="activity-view-toggles">
                <small>{scope.timezone}</small>
                <button
                  type="button"
                  className="icon-button favorite-filter"
                  aria-label="Показать только избранное"
                  title={
                    favoritesActive
                      ? "Выключить фильтр избранного"
                      : "Показать только избранное"
                  }
                  aria-pressed={favoritesActive}
                  onClick={toggleFavorites}
                >
                  <Star
                    size={16}
                    fill={favoritesActive ? "currentColor" : "none"}
                  />
                </button>
              </div>
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
                      : type === "Community" || type === "tg-channels"
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
          </div>
          <ActivityFeed
            key={JSON.stringify([
              scope.id,
              type,
              search,
              category,
              selectedSources,
              language,
              audience,
              selectedTags,
              evaluation,
              favoritesOnly,
              period,
              from,
              to,
              startHour,
              minAiScore,
              minMembers,
              maxMembers,
              sort,
              excludeSerbianLetters,
              onlyExcursions,
            ])}
            entities={filtered}
            pendingEntityIds={pendingEntityIds}
            today={today}
            evaluation={effectiveEvaluation}
            onOpen={onOpen}
            onSetState={onSetState}
          />
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
        </>
      )}
    </>
  );
}

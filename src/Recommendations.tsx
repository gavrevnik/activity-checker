import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Settings,
  Copy,
  CalendarDays,
  Music2,
  RefreshCw,
  ChevronDown,
  X,
  EyeOff,
  RotateCcw,
  Star,
  Mic,
  Users,
  TreePine,
  BicepsFlexed,
  Plus,
  Trash2,
  CalendarPlus,
} from "lucide-react";
import type { Scope } from "../shared/model";
import { localDay, eventDateLabel } from "../shared/dates";
import {
  calendarGroupLabels as groupLabels,
  calendarGroups,
  recommendationGroups,
  remainingWeek,
  recommendationsOnDay,
  recommendationTime,
  recommendationExpired,
  recommendationDay,
  recommendationSlots,
  recommendationIdentityKeys,
  type CalendarGroup as RecommendationGroup,
  type CalendarRecommendation as RecommendationItem,
  type RecommendationPrompts,
  type RecommendationSettings,
  type RecommendationsView,
  type RecommendationSourcesView,
} from "../shared/recommendations";
import { api } from "./api";
import { Busy, Button, Empty, External, Field, Modal } from "./components";

const dayLabel = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Date(day + "T12:00:00Z").toLocaleDateString("ru-RU", {
    timeZone: "UTC",
    ...options,
  });

const descriptionPreview = (description: string) => {
  const first =
    [
      ...new Intl.Segmenter("ru", { granularity: "sentence" }).segment(
        description.trim(),
      ),
    ][0]?.segment.trim() || "";
  if (first.length <= 220) return first;
  const shortened = first.slice(0, 220).replace(/\s+\S*$/, "");
  return shortened + "…";
};

const activityIcons = {
  sport: BicepsFlexed,
  walks: TreePine,
  social: Users,
  concerts: Mic,
  personal: CalendarPlus,
};
function RecommendationActivityIcon({
  group,
  decorative = false,
}: {
  group: RecommendationGroup;
  decorative?: boolean;
}) {
  const Icon = activityIcons[group];
  return (
    <span
      className={`rec-activity-icon rec-${group}`}
      title={groupLabels[group]}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : groupLabels[group]}
      aria-hidden={decorative || undefined}
    >
      <Icon size={16} aria-hidden="true" />
    </span>
  );
}

type RecommendationActions = {
  onHide?: (item: RecommendationItem) => void;
  hiding?: boolean;
  hideError?: string;
  isFavorite?: (item: RecommendationItem) => boolean;
  onFavorite?: (item: RecommendationItem) => void;
  favoriting?: boolean;
};
function HideRecommendationButton({
  item,
  onHide,
  hiding,
}: RecommendationActions & { item: RecommendationItem }) {
  return onHide ? (
    <button
      type="button"
      className="rec-hide-button"
      title={
        item.group === "personal" ? "Удалить моё событие" : "Скрыть событие"
      }
      aria-label={`${item.group === "personal" ? "Удалить" : "Скрыть"}: ${item.title}`}
      disabled={hiding}
      onClick={(e) => {
        e.stopPropagation();
        onHide(item);
      }}
    >
      {item.group === "personal" ? <Trash2 size={15} /> : <EyeOff size={15} />}
    </button>
  ) : null;
}
function FavoriteRecommendationButton({
  item,
  isFavorite,
  onFavorite,
  favoriting,
}: RecommendationActions & { item: RecommendationItem }) {
  const selected = isFavorite?.(item) || false;
  return onFavorite ? (
    <button
      type="button"
      className={`rec-favorite-button ${selected ? "selected" : ""}`}
      title={selected ? "Убрать из избранного" : "Планирую пойти"}
      aria-label={`${selected ? "Убрать из избранного" : "В избранное"}: ${item.title}`}
      aria-pressed={selected}
      disabled={favoriting}
      onClick={(e) => {
        e.stopPropagation();
        onFavorite(item);
      }}
    >
      <Star size={16} fill={selected ? "currentColor" : "none"} />
    </button>
  ) : null;
}

export function RecommendationCard({
  item,
  timeZone,
  day,
  onOpen,
  onHide,
  hiding,
  isFavorite,
  onFavorite,
  favoriting,
}: {
  item: RecommendationItem;
  timeZone: string;
  day?: string;
  onOpen?: () => void;
} & RecommendationActions) {
  return (
    <article
      className={`recommendation-card rec-${item.group} ${onOpen ? "rec-card-compact" : ""} ${isFavorite?.(item) ? "rec-is-favorite" : ""}`}
      onClick={
        onOpen
          ? (e) => {
              if (!(e.target instanceof Element) || !e.target.closest("a"))
                onOpen();
            }
          : undefined
      }
    >
      <div className="rec-card-meta">
        <span title="Время начала события">
          {day
            ? recommendationTime(item, day, timeZone)
            : eventDateLabel(item.startAt, timeZone)}
          {!day && item.startAt.length === 10 && " · время уточняется"}
        </span>
        <div className="rec-card-actions">
          <FavoriteRecommendationButton
            item={item}
            isFavorite={isFavorite}
            onFavorite={onFavorite}
            favoriting={favoriting}
          />
          <HideRecommendationButton
            item={item}
            onHide={onHide}
            hiding={hiding}
          />
        </div>
      </div>
      <h3>
        {onOpen ? (
          <button
            type="button"
            className="rec-card-open"
            aria-label={`Подробнее: ${item.title}`}
          >
            {item.title}
          </button>
        ) : (
          item.title
        )}
      </h3>
      <p>{onOpen ? descriptionPreview(item.description) : item.description}</p>
      <footer>
        {item.group === "personal" ? (
          <span className="muted">Моё событие</span>
        ) : (
          <External href={item.sourceUrl || item.eventUrl}>
            {item.sourceName}
          </External>
        )}
        <RecommendationActivityIcon group={item.group} />
      </footer>
    </article>
  );
}

export function RecommendationSlot({
  items,
  day,
  hour,
  timeZone,
  onOpen,
  onHide,
  hiding,
  ...favoriteActions
}: {
  items: RecommendationItem[];
  day: string;
  hour: number;
  timeZone: string;
  onOpen: () => void;
} & RecommendationActions) {
  if (!items.length) return null;
  if (items.length === 1)
    return (
      <RecommendationCard
        item={items[0]}
        timeZone={timeZone}
        day={day}
        onOpen={onOpen}
        onHide={onHide}
        hiding={hiding}
        {...favoriteActions}
      />
    );
  return (
    <div
      className="rec-slot-group"
      role="group"
      aria-label={`${items.length} событий · ${day} · ${hour < 0 ? "без времени" : String(hour).padStart(2, "0") + ":00"}`}
    >
      {items.map((item, index) => (
        <div
          key={index}
          className={`rec-slot-row ${favoriteActions.isFavorite?.(item) ? "rec-is-favorite" : ""}`}
        >
          <button
            type="button"
            onClick={onOpen}
            className={`rec-slot-title rec-${item.group}`}
          >
            {item.title}
          </button>
          <FavoriteRecommendationButton item={item} {...favoriteActions} />
          <HideRecommendationButton
            item={item}
            onHide={onHide}
            hiding={hiding}
          />
          <RecommendationActivityIcon group={item.group} decorative />
        </div>
      ))}
    </div>
  );
}

export function RecommendationSlotDetails({
  items,
  day,
  hour,
  timeZone,
  onClose,
  onHide,
  hiding,
  hideError,
  ...favoriteActions
}: {
  items: RecommendationItem[];
  day: string;
  hour: number;
  timeZone: string;
  onClose: () => void;
} & RecommendationActions) {
  return (
    <Modal
      wide
      title={`${dayLabel(day, { weekday: "long", day: "numeric", month: "long" })} · ${hour < 0 ? "время уточняется" : String(hour).padStart(2, "0") + ":00"}`}
      onClose={onClose}
    >
      <p className="muted">
        {items.length === 1 ? "1 событие" : `${items.length} событий`}. В
        календаре каждому отведён один час; точные условия участия смотрите в
        источнике.
      </p>
      {hideError && (
        <p className="error-text" role="alert">
          {hideError}
        </p>
      )}
      {!items.length && <Empty>В этом слоте больше нет видимых событий.</Empty>}
      <div className="rec-slot-details">
        {items.map((item, index) => (
          <RecommendationCard
            key={index}
            item={item}
            day={day}
            timeZone={timeZone}
            onHide={onHide}
            hiding={hiding}
            {...favoriteActions}
          />
        ))}
      </div>
    </Modal>
  );
}

export function RecommendationWeek({
  items,
  today,
  timeZone,
  filters,
  onHide,
  hiding,
  hideError,
  minimumStartHour = null,
  ...favoriteActions
}: {
  items: RecommendationItem[];
  today: string;
  timeZone: string;
  filters?: ReactNode;
  minimumStartHour?: number | null;
} & RecommendationActions) {
  const headingScroll = useRef<HTMLDivElement>(null);
  const calendarScroll = useRef<HTMLDivElement>(null);
  const [topbarHeight, setTopbarHeight] = useState(0);
  useEffect(() => {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    const measure = () =>
      setTopbarHeight(topbar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(topbar);
    return () => observer.disconnect();
  }, []);
  const [openedSlot, setOpenedSlot] = useState<{
    day: string;
    hour: number;
    items: RecommendationItem[];
  } | null>(null);
  const days = remainingWeek(today);
  const entries = days.map((day) => ({
    day,
    items: recommendationsOnDay(items, day, timeZone),
  }));
  const eventHours = entries.flatMap(({ day, items }) =>
    items
      .filter((item) => item.startAt.length !== 10)
      .map((item) =>
        Number(recommendationTime(item, day, timeZone).slice(0, 2)),
      )
      .filter((hour) => hour >= (minimumStartHour ?? 0)),
  );
  const firstHour = eventHours.length ? Math.min(...eventHours) : 24;
  const lastHour = eventHours.length ? Math.max(...eventHours) : 23;
  const hasUnknownTime = entries.some(({ items }) =>
    items.some((item) => item.startAt.length === 10),
  );
  const hours = [
    ...Array.from(
      { length: lastHour - firstHour + 1 },
      (_, index) => firstHour + index,
    ),
    ...(minimumStartHour === null && hasUnknownTime ? [-1] : []),
  ];
  const rowItems = (events: RecommendationItem[], day: string, hour: number) =>
    events.filter((item) => {
      const time = recommendationTime(item, day, timeZone);
      return hour < 0
        ? !/^\d{2}:/.test(time)
        : time.startsWith(String(hour).padStart(2, "0") + ":");
    });
  return (
    <section
      className="rec-week-calendar"
      style={
        {
          "--rec-days": days.length,
          "--rec-sticky-top": `${topbarHeight}px`,
        } as CSSProperties
      }
    >
      <div className="rec-calendar-sticky">
        {filters}
        <div
          ref={headingScroll}
          className="rec-calendar-heading-scroll"
          tabIndex={0}
          aria-label="Дни календаря, прокрутка по горизонтали"
          onScroll={(e) => {
            if (
              calendarScroll.current &&
              calendarScroll.current.scrollLeft !== e.currentTarget.scrollLeft
            )
              calendarScroll.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
        >
          <div className="rec-calendar">
            <div className="rec-day-heading">Время</div>
            {entries.map(({ day, items }) => (
              <div
                id={`rec-day-${day}`}
                key={day}
                className={`rec-day-heading ${day === today ? "today" : ""}`}
              >
                <strong>
                  {dayLabel(day, { weekday: "long" })} ({items.length})
                </strong>
                <span>{dayLabel(day, { day: "numeric", month: "long" })}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        ref={calendarScroll}
        className="rec-calendar-scroll"
        tabIndex={0}
        aria-label="Календарь рекомендаций, прокрутка по горизонтали"
        onScroll={(e) => {
          if (
            headingScroll.current &&
            headingScroll.current.scrollLeft !== e.currentTarget.scrollLeft
          )
            headingScroll.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div className="rec-calendar">
          {hours.map((hour) => (
            <Fragment key={hour}>
              <div className="rec-hour">
                {hour < 0
                  ? "Без времени"
                  : String(hour).padStart(2, "0") + ":00"}
              </div>
              {entries.map(({ day, items }) => (
                <div
                  key={day}
                  className={`rec-hour-cell ${day === today ? "today" : ""}`}
                >
                  <RecommendationSlot
                    items={rowItems(items, day, hour)}
                    hour={hour}
                    timeZone={timeZone}
                    day={day}
                    onHide={onHide}
                    hiding={hiding}
                    {...favoriteActions}
                    onOpen={() =>
                      setOpenedSlot({
                        day,
                        hour,
                        items: rowItems(items, day, hour),
                      })
                    }
                  />
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      {openedSlot && (
        <RecommendationSlotDetails
          {...openedSlot}
          items={rowItems(
            recommendationsOnDay(items, openedSlot.day, timeZone),
            openedSlot.day,
            openedSlot.hour,
          )}
          timeZone={timeZone}
          onClose={() => setOpenedSlot(null)}
          onHide={onHide}
          hiding={hiding}
          hideError={hideError}
          {...favoriteActions}
        />
      )}
    </section>
  );
}

export function RecommendationYear({
  items,
  timeZone,
  onHide,
  hiding,
  hideError,
  ...favoriteActions
}: {
  items: RecommendationItem[];
  timeZone: string;
} & RecommendationActions) {
  const [openedSlot, setOpenedSlot] = useState<{
    day: string;
    hour: number;
    items: RecommendationItem[];
  } | null>(null);
  const slots = recommendationSlots(items, timeZone);
  const months = [
    ...new Set(
      items.map((item) =>
        recommendationDay(item.startAt, timeZone).slice(0, 7),
      ),
    ),
  ].sort();
  return (
    <div className="rec-months">
      {!items.length && (
        <Empty>
          Подходящих предстоящих концертов и фестивалей на 2026 год пока нет.
        </Empty>
      )}
      {months.map((month) => (
        <section key={month} className="rec-month">
          <h2>{dayLabel(month + "-01", { month: "long", year: "numeric" })}</h2>
          <div className="rec-month-events">
            {slots
              .filter((slot) => slot.day.startsWith(month))
              .map((slot) => (
                <div
                  className="rec-month-event"
                  key={`${slot.day}-${slot.hour}`}
                >
                  <div className="rec-date-badge">
                    <strong>
                      {dayLabel(slot.day, {
                        day: "numeric",
                      })}
                    </strong>
                    <span>
                      {dayLabel(slot.day, {
                        weekday: "short",
                      })}
                    </span>
                  </div>
                  <RecommendationSlot
                    {...slot}
                    timeZone={timeZone}
                    onOpen={() => setOpenedSlot(slot)}
                    onHide={onHide}
                    hiding={hiding}
                    {...favoriteActions}
                  />
                </div>
              ))}
          </div>
        </section>
      ))}
      {openedSlot && (
        <RecommendationSlotDetails
          {...openedSlot}
          items={
            slots.find(
              (slot) =>
                slot.day === openedSlot.day && slot.hour === openedSlot.hour,
            )?.items || []
          }
          timeZone={timeZone}
          onClose={() => setOpenedSlot(null)}
          onHide={onHide}
          hiding={hiding}
          hideError={hideError}
          {...favoriteActions}
        />
      )}
    </div>
  );
}

export function RecommendationSourcesList({
  sources,
}: {
  sources: RecommendationSourcesView;
}) {
  const list = (items: RecommendationSourcesView["other"]) => (
    <ul className="rec-source-list">
      {items.map((source) => (
        <li
          key={source.id}
          className={source.enabled ? "" : "rec-source-excluded"}
        >
          <div>
            {source.url ? (
              <External href={source.url}>{source.name}</External>
            ) : (
              <span>{source.name}</span>
            )}
            {source.method !== "telegram" && (
              <span className="rec-source-method">
                {source.method === "aggregator"
                  ? "Агрегатор"
                  : source.method === "web"
                    ? "Веб-поиск"
                    : "Из подборки"}
              </span>
            )}
          </div>
          <small>{source.description}</small>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      className="rec-search-sources"
      aria-label="Источники поиска мероприятий"
    >
      <h3>Источники поиска мероприятий</h3>
      <p className="muted">
        Список Telegram обновляется из коллекции каналов активностей Personal
        Radar при открытии настроек.
      </p>
      {sources.warning && (
        <p className="notice error" role="alert">
          {sources.warning}
        </p>
      )}
      <details className="rec-telegram-sources">
        <summary>
          Telegram-каналы ·{" "}
          {sources.warning ? "список недоступен" : sources.telegram.length}
        </summary>
        {sources.telegram.length
          ? list(sources.telegram)
          : !sources.warning && (
              <p className="muted">
                В Knowledge пока нет включённых публичных каналов активностей.
              </p>
            )}
      </details>
      <h4>Другие источники</h4>
      {list(sources.other)}
      {sources.additional.length > 0 && (
        <>
          <h4>Дополнительные сайты из сохранённых рекомендаций</h4>
          {list(sources.additional)}
        </>
      )}
      <p className="muted">
        Модель также использует веб-поиск по сайтам организаторов, площадок и
        исполнителей, чтобы проверить даты и условия или дополнить подборку.
      </p>
    </section>
  );
}

function RecommendationSources({ scopeId }: { scopeId: string }) {
  const [sources, setSources] = useState<RecommendationSourcesView | null>(
    null,
  );
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<RecommendationSourcesView>(
      `/recommendations/sources?scopeId=${encodeURIComponent(scopeId)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setSources(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [scopeId, retry]);
  if (error)
    return (
      <section className="rec-search-sources">
        <h3>Источники поиска мероприятий</h3>
        <p className="error-text" role="alert">
          {error}
        </p>
        <Button
          onClick={() => {
            setError("");
            setRetry((value) => value + 1);
          }}
        >
          Повторить загрузку
        </Button>
      </section>
    );
  return sources ? (
    <RecommendationSourcesList sources={sources} />
  ) : (
    <section className="rec-search-sources">
      <h3>Источники поиска мероприятий</h3>
      <p className="muted">
        <Busy /> Загрузка списка источников…
      </p>
    </section>
  );
}

function RecommendationSettingsModal({
  settings,
  scopeId,
  onClose,
  onSaved,
}: {
  settings: RecommendationSettings;
  scopeId: string;
  onClose: () => void;
  onSaved: (settings: RecommendationSettings) => void;
}) {
  const [prompts, setPrompts] = useState<RecommendationPrompts>({
    ...settings.prompts,
  });
  const [expectedRevision] = useState(settings.revision);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api<RecommendationSettings>("/recommendations/settings", "PUT", {
          expectedRevision,
          prompts,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Критерии рекомендаций"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <p className="muted">
        Для каждой группы — один промпт поиска и отбора. Новые критерии
        применяются при следующем запуске модели, включая концерты и фестивали
        2026 года.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="rec-settings-form"
      >
        {recommendationGroups.map((group) => (
          <Field key={group} label={groupLabels[group]}>
            <textarea
              required
              maxLength={12000}
              rows={5}
              value={prompts[group]}
              disabled={busy}
              onChange={(e) =>
                setPrompts({ ...prompts, [group]: e.target.value })
              }
            />
          </Field>
        ))}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <RecommendationSources scopeId={scopeId} />
        <div className="rec-actions">
          <Button onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button primary type="submit" disabled={busy}>
            {busy && <Busy />}Сохранить критерии
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PersonalRecommendationModal({
  scopeId,
  today,
  onClose,
  onSaved,
}: {
  scopeId: string;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [day, setDay] = useState(today);
  const [hour, setHour] = useState("19");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const days = remainingWeek(today);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/recommendations/personal", "POST", {
        id,
        scopeId,
        day,
        hour: Number(hour),
        title,
        description,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Добавить моё событие"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="rec-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="День недели">
          <select
            aria-label="День недели"
            value={day}
            disabled={busy}
            onChange={(e) => setDay(e.target.value)}
          >
            {days.map((value) => (
              <option key={value} value={value}>
                {dayLabel(value, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Час начала">
          <select
            aria-label="Час начала"
            value={hour}
            disabled={busy}
            onChange={(e) => setHour(e.target.value)}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={hour}>
                {String(hour).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </Field>
        <Field label="Название события">
          <input
            aria-label="Название события"
            required
            maxLength={500}
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Описание">
          <textarea
            aria-label="Описание"
            rows={5}
            maxLength={10000}
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <p className="muted">
          Событие сохранится отдельно от подборок модели. Удалённое можно
          восстановить из «Скрытого» до конца этой недели.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="rec-actions">
          <Button disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button primary type="submit" disabled={busy || !title.trim()}>
            {busy && <Busy />}Добавить событие
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Recommendations({ scope }: { scope: Scope }) {
  const [kind, setKind] = useState<"week" | "concerts-2026">("week");
  const [view, setView] = useState<RecommendationsView | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false),
    [copied, setCopied] = useState(false);
  const [updateDetails, setUpdateDetails] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [addingPersonal, setAddingPersonal] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [clockNow, setClockNow] = useState(() => new Date());
  const selectionRef = useRef("");
  selectionRef.current = `${scope.id}/${kind}`;
  const [refresh, setRefresh] = useState(0);
  const [startHour, setStartHour] = useState("");
  const hourMatch = startHour.trim().match(/^(\d{1,2})(?::00)?$/);
  const selectedHour =
    hourMatch && Number(hourMatch[1]) < 24 ? Number(hourMatch[1]) : null;
  const invalidHour = Boolean(startHour.trim()) && selectedHour === null;
  const [groups, setGroups] = useState<RecommendationGroup[]>([
    ...calendarGroups,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setClockNow(new Date());
      try {
        const value = await api<RecommendationsView>(
          `/recommendations?scopeId=${encodeURIComponent(scope.id)}&kind=${kind}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setView(value);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 30000);
    window.addEventListener("focus", load);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("focus", load);
    };
  }, [kind, scope.id, refresh]);
  const timeZone = view?.timeZone || scope.timezone;
  const today = localDay(clockNow, timeZone);
  const snapshot = view?.snapshot;
  const hidden = [
    ...(view?.hidden || []),
    ...(view?.personal || [])
      .filter((item) => item.deletedAt)
      .map((item) => ({
        id: "personal:" + item.id,
        item,
        hiddenAt: item.deletedAt!,
      })),
  ].filter((row) => !recommendationExpired(row.item, clockNow, timeZone));
  const favoriteKeys = new Set(
    (view?.favorites || [])
      .filter((row) => !recommendationExpired(row.item, clockNow, timeZone))
      .flatMap((row) => recommendationIdentityKeys(row.item, timeZone)),
  );
  const isFavorite = (item: RecommendationItem) =>
    item.group === "personal"
      ? item.favorite
      : recommendationIdentityKeys(item, timeZone).some((key) =>
          favoriteKeys.has(key),
        );
  const changeFavorite = async (item: RecommendationItem) => {
    const selection = selectionRef.current;
    setFavoriteBusy(true);
    try {
      await api(
        item.group === "personal"
          ? "/recommendations/personal/state"
          : "/recommendations/favorite",
        "PUT",
        {
          scopeId: scope.id,
          ...(item.group === "personal" ? { id: item.id } : { item }),
          favorite: !isFavorite(item),
        },
      );
      const value = await api<RecommendationsView>(
        `/recommendations?scopeId=${encodeURIComponent(scope.id)}&kind=${kind}`,
      );
      if (selectionRef.current === selection) {
        setView(value);
        setError("");
      }
    } catch (e) {
      if (selectionRef.current === selection) setError((e as Error).message);
    } finally {
      setFavoriteBusy(false);
    }
  };
  const favoriteActions = {
    isFavorite,
    onFavorite: (item: RecommendationItem) => void changeFavorite(item),
    favoriting: favoriteBusy || visibilityBusy,
  };
  const favoriteFilter = (
    <button
      type="button"
      className={`icon-button rec-favorites-toggle ${onlyFavorites ? "active" : ""}`}
      aria-pressed={onlyFavorites}
      aria-label="Только избранное"
      title={
        onlyFavorites ? "Показать все события" : "Показать только избранное"
      }
      onClick={() => setOnlyFavorites((current) => !current)}
    >
      <Star
        size={18}
        fill={onlyFavorites ? "currentColor" : "none"}
        aria-hidden="true"
      />
    </button>
  );
  const changeVisibility = async (itemOrId: RecommendationItem | string) => {
    const selection = selectionRef.current;
    setVisibilityBusy(true);
    try {
      const personalId =
        typeof itemOrId === "string"
          ? itemOrId.startsWith("personal:")
            ? itemOrId.slice(9)
            : null
          : itemOrId.group === "personal"
            ? itemOrId.id
            : null;
      if (personalId) {
        await api("/recommendations/personal/state", "PUT", {
          scopeId: scope.id,
          id: personalId,
          deleted: typeof itemOrId !== "string",
        });
      } else {
        await api(
          typeof itemOrId === "string"
            ? "/recommendations/restore"
            : "/recommendations/hide",
          "POST",
          typeof itemOrId === "string"
            ? { scopeId: scope.id, id: itemOrId }
            : { scopeId: scope.id, item: itemOrId },
        );
      }
      const value = await api<RecommendationsView>(
        `/recommendations?scopeId=${encodeURIComponent(scope.id)}&kind=${kind}`,
      );
      if (selectionRef.current === selection) {
        setView(value);
        setClockNow(new Date());
        setError("");
      }
    } catch (e) {
      if (selectionRef.current === selection) setError((e as Error).message);
      setRefresh((n) => n + 1);
    } finally {
      setVisibilityBusy(false);
    }
  };
  const matchesStartHour = (item: RecommendationItem) => {
    if (selectedHour === null) return true;
    const hour = recommendationTime(
      item,
      recommendationDay(item.startAt, timeZone),
      timeZone,
    ).match(/^(\d{2}):/);
    return hour !== null && Number(hour[1]) >= selectedHour;
  };
  const calendarItems: RecommendationItem[] = [
    ...(snapshot?.items || []),
    ...(kind === "week"
      ? (view?.personal || []).filter((item) => !item.deletedAt)
      : []),
  ];
  const items = calendarItems.filter(
    (item) =>
      (kind !== "week" || groups.includes(item.group)) &&
      (kind !== "week" || matchesStartHour(item)) &&
      (!onlyFavorites || isFavorite(item)) &&
      !recommendationExpired(item, clockNow, timeZone) &&
      (!view ||
        (recommendationDay(item.startAt, timeZone) >= today &&
          recommendationDay(item.startAt, timeZone) <= view.period.endDate)),
  );
  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(
        `Используй $activity-recommendations: обнови ${kind === "week" ? "рекомендации с сегодняшнего дня до воскресенья текущей недели" : "концерты, выступления и фестивали до конца 2026 года"} для scopeId=${scope.id}. Прочитай актуальные промпты /api/recommendations и полный список Telegram-каналов активностей из Knowledge Personal Radar. Сохрани результат на странице «Рекомендации».`,
      );
      setCopied(true);
      setError("");
    } catch {
      setError(
        "Не удалось скопировать. Напишите модели: «Используй $activity-recommendations и обнови рекомендации».",
      );
    }
  };
  return (
    <div className="recommendations-page">
      <div className="rec-page-heading">
        <div>
          <h1>Рекомендации</h1>
          <p className="muted">
            {scope.name} · {timeZone}
          </p>
        </div>
        <div className="rec-actions">
          {kind === "week" && (
            <button
              type="button"
              className="icon-button"
              aria-label="Добавить событие"
              title="Добавить моё событие"
              disabled={!view}
              onClick={() => setAddingPersonal(true)}
            >
              <Plus size={20} />
            </button>
          )}
          <Button
            onClick={() => {
              setCopied(false);
              void copyRequest();
            }}
          >
            <Copy size={16} />
            {copied ? "Запрос скопирован" : "Запрос для модели"}
          </Button>
          <button
            className="icon-button"
            aria-label="Настройки рекомендаций"
            disabled={!view}
            onClick={() => setEditing(true)}
          >
            <Settings size={20} />
          </button>
          <button
            className="icon-button"
            aria-label="Обновить сохранённые рекомендации"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>
      <div className="rec-updated">
        <span>
          Последнее обновление:{" "}
          <strong>
            {snapshot
              ? new Date(snapshot.updatedAt).toLocaleString("ru-RU", {
                  timeZone,
                })
              : "ещё не обновлялись"}
          </strong>
        </span>
        {snapshot?.notes && (
          <Button onClick={() => setUpdateDetails(snapshot.notes)}>
            Подробнее
          </Button>
        )}
        <Button disabled={!view} onClick={() => setShowHidden(true)}>
          <EyeOff size={14} />
          Скрытое{hidden.length ? ` (${hidden.length})` : ""}
        </Button>
      </div>
      <p className="muted">
        Подборку обновляет модель по вашему запросу. Скопируйте запрос и
        отправьте его в чат с моделью.
      </p>
      <p className="muted">
        События размещены по дате начала. В календаре каждому отведён один час.
      </p>
      <div className="rec-tabs" role="tablist" aria-label="Период рекомендаций">
        {(["week", "concerts-2026"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={kind === tab}
            className={kind === tab ? "active" : ""}
            onClick={() => {
              if (tab !== kind) {
                setView(null);
                setError("");
                setCopied(false);
                setKind(tab);
              }
            }}
          >
            {tab === "week" ? <CalendarDays size={16} /> : <Music2 size={16} />}
            {tab === "week" ? "Текущая неделя" : "Концерты и фестивали 2026"}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!view ? (
        <div className="loading">
          <Busy />
          Загрузка рекомендаций…
        </div>
      ) : (
        <>
          {snapshot && snapshot.settingsRevision !== view.settings.revision && (
            <p className="notice">
              Критерии изменены после последнего подбора. Обновите рекомендации
              через модель.
            </p>
          )}
          {kind === "week" ? (
            <>
              {!items.length && (
                <Empty>
                  {snapshot
                    ? "На оставшиеся дни недели нет рекомендаций с выбранными фильтрами."
                    : "Подборка пока не создана. Запустите activity-recommendations через модель."}
                </Empty>
              )}
              <RecommendationWeek
                items={items}
                today={today}
                timeZone={timeZone}
                minimumStartHour={selectedHour}
                onHide={(item) => void changeVisibility(item)}
                hiding={visibilityBusy || favoriteBusy}
                hideError={error}
                {...favoriteActions}
                filters={
                  <div className="rec-filters" aria-label="Группы активностей">
                    {calendarGroups.map((group) => (
                      <label key={group} className={`rec-filter rec-${group}`}>
                        <input
                          type="checkbox"
                          checked={groups.includes(group)}
                          onChange={() =>
                            setGroups((current) =>
                              current.includes(group)
                                ? current.filter((g) => g !== group)
                                : [...current, group],
                            )
                          }
                        />
                        <RecommendationActivityIcon group={group} decorative />
                        {groupLabels[group]}
                      </label>
                    ))}
                    <label
                      className="rec-groups-toggle"
                      title={
                        groups.length === calendarGroups.length
                          ? "Снять все отметки типов событий"
                          : "Выбрать все типы событий"
                      }
                    >
                      <input
                        type="checkbox"
                        aria-label={
                          groups.length === calendarGroups.length
                            ? "Снять все отметки типов событий"
                            : "Выбрать все типы событий"
                        }
                        checked={groups.length === calendarGroups.length}
                        ref={(element) => {
                          if (element)
                            element.indeterminate =
                              groups.length > 0 &&
                              groups.length < calendarGroups.length;
                        }}
                        onChange={() =>
                          setGroups((current) =>
                            current.length === calendarGroups.length
                              ? []
                              : [...calendarGroups],
                          )
                        }
                      />
                    </label>
                    <div className="rec-hour-filter">
                      <label htmlFor="rec-start-hour">Начало с</label>
                      <div className="rec-hour-input">
                        <input
                          id="rec-start-hour"
                          type="text"
                          inputMode="numeric"
                          placeholder="Все часы"
                          title="События с началом в этот час или позже"
                          value={startHour}
                          aria-invalid={invalidHour}
                          aria-describedby={
                            invalidHour ? "rec-hour-error" : undefined
                          }
                          onChange={(e) => setStartHour(e.target.value)}
                          onBlur={() => {
                            if (selectedHour !== null)
                              setStartHour(
                                `${String(selectedHour).padStart(2, "0")}:00`,
                              );
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                        <div className="rec-hour-picker">
                          <select
                            aria-label="Выбрать минимальный час начала"
                            title="Выбрать минимальный час начала"
                            value={
                              selectedHour === null ? "" : String(selectedHour)
                            }
                            onChange={(e) =>
                              setStartHour(
                                e.target.value === ""
                                  ? ""
                                  : `${e.target.value.padStart(2, "0")}:00`,
                              )
                            }
                          >
                            <option value="">Все часы</option>
                            {Array.from({ length: 24 }, (_, hour) => (
                              <option key={hour} value={hour}>
                                {String(hour).padStart(2, "0")}:00
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      </div>
                      {startHour && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Сбросить фильтр часа"
                          onClick={() => setStartHour("")}
                        >
                          <X size={14} />
                        </button>
                      )}
                      {invalidHour && (
                        <span
                          id="rec-hour-error"
                          className="error-text"
                          role="alert"
                        >
                          Укажите час от 0 до 23, например 19 или 19:00.
                        </span>
                      )}
                    </div>
                    {favoriteFilter}
                  </div>
                }
              />
            </>
          ) : (
            <>
              <div className="rec-filters">{favoriteFilter}</div>
              <RecommendationYear
                items={items}
                timeZone={timeZone}
                onHide={(item) => void changeVisibility(item)}
                hiding={visibilityBusy || favoriteBusy}
                hideError={error}
                {...favoriteActions}
              />
            </>
          )}
        </>
      )}
      {updateDetails && (
        <Modal
          wide
          title="Подробности обновления рекомендаций"
          onClose={() => setUpdateDetails(null)}
        >
          <p className="rec-notes">{updateDetails}</p>
        </Modal>
      )}
      {showHidden && (
        <Modal
          wide
          title="Скрытые рекомендации"
          onClose={() => setShowHidden(false)}
        >
          <p className="muted">
            Эти события исключены из обеих вкладок и новых подборок до окончания
            события. Их можно восстановить. Удалённые «Мои события» хранятся до
            конца недели.
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {!hidden.length ? (
            <Empty>Скрытых предстоящих событий нет.</Empty>
          ) : (
            <div className="rec-hidden-list">
              {hidden.map((row) => (
                <div key={row.id}>
                  <RecommendationCard
                    item={row.item}
                    timeZone={timeZone}
                    {...favoriteActions}
                  />
                  <Button
                    disabled={visibilityBusy}
                    onClick={() => void changeVisibility(row.id)}
                  >
                    <RotateCcw size={14} />
                    Восстановить
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
      {addingPersonal && kind === "week" && (
        <PersonalRecommendationModal
          key={scope.id + today}
          scopeId={scope.id}
          today={today}
          onClose={() => setAddingPersonal(false)}
          onSaved={() => {
            setAddingPersonal(false);
            setGroups((current) =>
              current.includes("personal") ? current : [...current, "personal"],
            );
            setRefresh((n) => n + 1);
          }}
        />
      )}
      {editing && view && (
        <RecommendationSettingsModal
          settings={view.settings}
          scopeId={scope.id}
          onClose={() => setEditing(false)}
          onSaved={(settings) => {
            setView((current) =>
              current ? { ...current, settings } : current,
            );
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

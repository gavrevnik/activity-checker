import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Search, RefreshCw, Settings } from "lucide-react";
import { api } from "./api";
import {
  Button,
  Busy,
  CheckboxMultiSelect,
  Empty,
  External,
  Modal,
} from "./components";
import { localDay, periodDateRange } from "../shared/dates";
import {
  matchesTelegramEventDates,
  sortTelegramEvents,
  type TelegramEventSort,
} from "../shared/telegram-event-dates";
import { DateRangeFilter } from "./DateRangeFilter";
import { TelegramEventDateBadge } from "./TelegramEventDateBadge";
import type { Scope } from "../shared/model";
import type {
  TelegramEvent,
  TelegramEventsView,
} from "../shared/telegram-events";
import "./telegram-events.css";
import { TelegramMonitoringSettings } from "./TelegramMonitoringSettings";
import {
  matchesTelegramScore,
  isTelegramScoreInput,
} from "../shared/telegram-monitoring";
import { matchesEvaluation } from "../shared/personal-state";
import { createEntityStateUpdater } from "./entity-state";
import { savePersonalState } from "./entity-state-api";
import { EventReactions } from "./EventReactions";
import { useRetainedFeedbackCards } from "./DislikeFeedback";
import { feedbackCardKey } from "./feedback-retention";

export function TelegramEvents({
  scope,
  onCountChange,
}: {
  scope: Scope;
  onCountChange: (count: number) => void;
}) {
  const retainedFeedbackCards = useRetainedFeedbackCards();
  const [data, setData] = useState<TelegramEventsView | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("");
  const [selected, setSelected] = useState<TelegramEvent | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [minScore, setMinScore] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [period, setPeriod] = useState("");
  const [sort, setSort] = useState<TelegramEventSort>("date-asc");
  const [evaluation, setEvaluation] = useState<string[] | null>(["unrated"]);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionError, setActionError] = useState("");
  const onSetState = useMemo(
    () =>
      createEntityStateUpdater<TelegramEvent>({
        save: (id, state) =>
          savePersonalState<TelegramEvent>("/telegram-events", id, state),
        patch: (id, state) => {
          setData((current) =>
            current
              ? {
                  ...current,
                  events: current.events.map((event) =>
                    event.id === id ? { ...event, ...state } : event,
                  ),
                }
              : current,
          );
          setSelected((current) =>
            current?.id === id ? { ...current, ...state } : current,
          );
        },
        pending: (id, value) => {
          if (value) setActionError("");
          setPendingIds((current) => {
            const next = new Set(current);
            if (value) next.add(id);
            else next.delete(id);
            return next;
          });
        },
        reportError: (err) => setActionError((err as Error).message),
      }),
    [],
  );
  const setExiting = (id: string, value: boolean) =>
    setExitingIds((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    setSelected(null);
    api<TelegramEventsView>(
      `/telegram-events?scopeId=${encodeURIComponent(scope.id)}`,
    )
      .then((value) => {
        if (!cancelled) {
          setData(value);
          onCountChange(value.events.length);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [scope.id, revision, onCountChange]);
  const today = localDay(new Date(), scope.timezone);
  const periodRange = periodDateRange(period, today);
  const dateFrom = from || periodRange.from;
  const dateTo = to || periodRange.to;
  const events = useMemo(
    () =>
      sortTelegramEvents(
        (data?.events || []).filter(
          (event) =>
            (!channel || event.communityId === channel) &&
            (retainedFeedbackCards.has(
              feedbackCardKey("telegram-events", event.id),
            ) ||
              matchesEvaluation(event, evaluation)) &&
            matchesTelegramScore(event.relevanceScore, minScore) &&
            matchesTelegramEventDates(
              event,
              dateFrom,
              dateTo,
              scope.timezone,
            ) &&
            (!search ||
              [
                event.title,
                event.postTitle,
                event.channelTitle,
                event.fullText,
                ...event.channelTags,
              ]
                .join(" ")
                .toLocaleLowerCase("ru")
                .includes(search.toLocaleLowerCase("ru"))),
        ),
        sort,
        scope.timezone,
      ),
    [
      data,
      channel,
      search,
      minScore,
      evaluation,
      retainedFeedbackCards,
      dateFrom,
      dateTo,
      sort,
      scope.timezone,
    ],
  );
  const channels = [
    ...new Map(
      (data?.events || []).map((event) => [
        event.communityId,
        event.channelTitle,
      ]),
    ).entries(),
  ];
  return (
    <section className="telegram-events" aria-label="Посты">
      <div className="telegram-events-intro">
        <p>
          Только проверенные мероприятия по вашему профилю. Отдельно от общих
          событий.
        </p>
        <Button
          disabled={pendingIds.size > 0}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
          Обновить список
        </Button>
      </div>
      {data?.review && (
        <p className="telegram-events-period">
          Публикации {data.review.startDate} — {data.review.endDate} · проверено{" "}
          {data.review.channels.length} сообществ · время Белграда
        </p>
      )}
      <div className="filter-bar">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Поиск Telegram-мероприятий"
            placeholder="Мероприятие, канал или тег"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <CheckboxMultiSelect
          label="Оценка"
          allLabel="Все оценки"
          value={evaluation}
          onChange={setEvaluation}
          options={[
            {
              value: "skipped",
              label: "Пропущено",
              count: (data?.events || []).filter((event) => event.skipped)
                .length,
            },
            {
              value: "unrated",
              label: "Не оценено",
              count: (data?.events || []).filter((event) =>
                matchesEvaluation(event, ["unrated"]),
              ).length,
            },
            {
              value: "liked",
              label: "Понравилось",
              count: (data?.events || []).filter(
                (event) => event.reaction === "like",
              ).length,
            },
            {
              value: "disliked",
              label: "Не понравилось",
              count: (data?.events || []).filter(
                (event) => event.reaction === "dislike",
              ).length,
            },
            {
              value: "favorite",
              label: "Избранное",
              count: (data?.events || []).filter((event) => event.favorite)
                .length,
            },
          ]}
        />
        <select
          aria-label="Канал Telegram"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
        >
          <option value="">Все каналы</option>
          {channels.map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <DateRangeFilter
          from={dateFrom}
          to={dateTo}
          today={today}
          period={period}
          onRange={(start, end) => {
            setFrom(start);
            setTo(end);
            setPeriod("");
          }}
          onPeriod={(value) => {
            setPeriod(value);
            setFrom("");
            setTo("");
          }}
        />
        <select
          aria-label="Сортировка Telegram-мероприятий"
          value={sort}
          onChange={(event) => setSort(event.target.value as TelegramEventSort)}
        >
          <option value="date-asc">По дате события ↑</option>
          <option value="date-desc">По дате события ↓</option>
          <option value="score-desc">По AI-score ↓</option>
        </select>
        <Button onClick={() => setSettingsOpen(true)}>
          <Settings size={15} />
          Настройки
        </Button>
        <label className="telegram-score-filter">
          AI-score от
          <input
            type="text"
            inputMode="numeric"
            aria-label="Минимальный AI-score от 0 до 10"
            placeholder="0–10"
            title="Показывать события с AI-score не ниже указанного числа. Пустое поле — без ограничения."
            value={minScore}
            onChange={(event) => {
              const value = event.target.value;
              if (isTelegramScoreInput(value)) setMinScore(value);
            }}
          />
        </label>
      </div>
      {settingsOpen && (
        <TelegramMonitoringSettings onClose={() => setSettingsOpen(false)} />
      )}
      {actionError && (
        <p role="alert" className="telegram-events-error">
          {actionError}
        </p>
      )}
      {error && (
        <div role="alert" className="telegram-events-error">
          {error}
          <Button onClick={() => setRevision((value) => value + 1)}>
            Повторить
          </Button>
        </div>
      )}
      {!data && !error && (
        <p role="status">
          <Busy />
          Загружаю проверенные мероприятия…
        </p>
      )}
      {data && (
        <>
          <div className="list-caption">
            Мероприятий: {events.length} · даты мероприятий, не публикаций
          </div>
          <div className="telegram-event-list">
            {events.map((event) => (
              <article
                className={`telegram-event-card ${exitingIds.has(event.id) ? "action-exiting" : ""}`}
                aria-busy={pendingIds.has(event.id) || undefined}
                key={event.id}
              >
                <div className="telegram-event-heading">
                  <CalendarDays size={19} />
                  <div className="telegram-event-title">
                    <button
                      className="telegram-event-open"
                      onClick={() => setSelected(event)}
                    >
                      <h3>{event.title}</h3>
                    </button>
                    <TelegramEventDateBadge
                      startAt={event.startAt}
                      endAt={event.endAt}
                      timeZone={scope.timezone}
                    />
                  </div>
                  <span title="Релевантность по профилю">
                    AI {event.relevanceScore}/10
                  </span>
                  <EventReactions
                    collection="telegram-events"
                    entity={event}
                    pending={pendingIds.has(event.id)}
                    onSetState={onSetState}
                    willHide={(state) =>
                      !matchesEvaluation({ ...event, ...state }, evaluation)
                    }
                    onExitChange={(value) => setExiting(event.id, value)}
                  />
                </div>
                {event.reaction === "dislike" && event.dislikeReason && (
                  <p className="dislike-reason">
                    Причина: {event.dislikeReason}
                  </p>
                )}
                {event.skipped && event.skipReason && (
                  <p className="skip-reason">
                    Причина пропуска: {event.skipReason}
                  </p>
                )}
                {event.venue && (
                  <p className="telegram-event-date">{event.venue}</p>
                )}
                <p className="telegram-event-source">
                  <External href={`https://t.me/${event.channelUsername}`}>
                    {event.channelTitle}
                  </External>{" "}
                  · @{event.channelUsername}
                </p>
                {event.postTitle !== event.title && (
                  <p className="telegram-post-title">Пост: {event.postTitle}</p>
                )}
                <ul className="telegram-channel-tags" aria-label="Теги канала">
                  {event.channelTags.map((tag) => (
                    <li key={tag}>#{tag}</li>
                  ))}
                </ul>
                <p className="telegram-event-preview">{event.preview}</p>
                <p className="telegram-event-relevance">
                  {event.relevanceReason}
                </p>
                <div className="telegram-event-actions">
                  <Button onClick={() => setSelected(event)}>
                    Полный текст
                  </Button>
                  <External href={event.postUrl}>Пост в Telegram</External>
                </div>
              </article>
            ))}
          </div>
          {!events.length && (
            <Empty>
              <CalendarDays size={30} />
              <h3>
                {data.events.length
                  ? "Ничего не найдено"
                  : "Пока нет проверенных мероприятий"}
              </h3>
              <p>
                Здесь появятся только подходящие объявления с подтверждённой
                датой.
              </p>
            </Empty>
          )}
        </>
      )}
      {data?.review && (
        <details className="telegram-channel-review">
          <summary>Каналы: результат проверки за этот период</summary>
          <p>
            Низкая отдача за три дня не означает, что канал в целом бесполезен.
          </p>
          <ul>
            {data.review.channels.map((item) => (
              <li key={item.communityId}>
                <External href={`https://t.me/${item.username}`}>
                  {item.title}
                </External>{" "}
                —{" "}
                {item.lowRelevance
                  ? "мало релевантного"
                  : item.returnedCount
                    ? "проверено"
                    : "нет публикаций"}
                ; отобрано {item.acceptedCount} из {item.returnedCount}.{" "}
                {item.reason}
                {item.truncated && " Сбор неполный: достигнут лимит."}
              </li>
            ))}
          </ul>
          {data.review.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
      {selected && (
        <Modal title={selected.title} onClose={() => setSelected(null)} wide>
          <EventReactions
            collection="telegram-events"
            entity={selected}
            pending={pendingIds.has(selected.id)}
            onSetState={onSetState}
            willHide={() => false}
            onExitChange={() => {}}
          />
          <p>
            <TelegramEventDateBadge
              startAt={selected.startAt}
              endAt={selected.endAt}
              timeZone={scope.timezone}
            />
            {selected.venue && ` · ${selected.venue}`}
          </p>
          {selected.reaction === "dislike" && selected.dislikeReason && (
            <p className="dislike-reason">Причина: {selected.dislikeReason}</p>
          )}
          {selected.skipped && selected.skipReason && (
            <p className="skip-reason">
              Причина пропуска: {selected.skipReason}
            </p>
          )}
          <p>
            <External href={`https://t.me/${selected.channelUsername}`}>
              {selected.channelTitle}
            </External>
          </p>
          <ul className="telegram-channel-tags" aria-label="Теги канала">
            {selected.channelTags.map((tag) => (
              <li key={tag}>#{tag}</li>
            ))}
          </ul>
          <p>{selected.relevanceReason}</p>
          <p className="telegram-events-period">
            Проверка: {selected.validationNotes}
          </p>
          <h3>Исходный пост: {selected.postTitle}</h3>
          <p className="telegram-post-full">{selected.fullText}</p>
          <External href={selected.postUrl}>
            Открыть исходный пост в Telegram
          </External>
        </Modal>
      )}
    </section>
  );
}

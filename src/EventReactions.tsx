import { useRef, useState, type MouseEvent } from "react";
import { Star, ThumbsUp, ThumbsDown } from "lucide-react";
import type {
  PersonalState,
  PersonalStatePatch,
} from "../shared/personal-state";
import type { SetPersonalState } from "./entity-state";
import { useDislikeFeedback } from "./DislikeFeedback";
import { feedbackCardKey, type FeedbackCollection } from "./feedback-retention";
import { normalizePersonalStatePatch } from "../shared/personal-state";

export function EventReactions<T extends PersonalState>({
  entity,
  onSetState,
  willHide,
  pending,
  onExitChange,
  collection = "entities",
}: {
  entity: T;
  onSetState: SetPersonalState<T>;
  willHide: (state: PersonalStatePatch) => boolean;
  pending: boolean;
  onExitChange: (exiting: boolean) => void;
  collection?: FeedbackCollection;
}) {
  const currentEntity = useRef(entity);
  currentEntity.current = entity;
  const openFeedback = useDislikeFeedback();
  const [pressed, setPressed] = useState<
    "" | "like" | "dislike" | "favorite" | "skip"
  >("");
  const update = async (
    key: "like" | "dislike" | "favorite" | "skip",
    state: PersonalStatePatch,
  ) => {
    if (pressed || pending) return false;
    setPressed(key);
    try {
      return await onSetState(
        entity,
        state,
        !(state.reaction === "dislike" || state.skipped === true) &&
          willHide(state)
          ? async () => {
              onExitChange(true);
              await new Promise<void>((resolve) => setTimeout(resolve, 118));
            }
          : undefined,
      );
    } finally {
      onExitChange(false);
      setPressed("");
    }
  };
  const rateWithFeedback = (
    event: MouseEvent<HTMLButtonElement>,
    kind: "dislike" | "skip",
  ) => {
    if (pressed || pending) return;
    const isSkip = kind === "skip";
    const alreadyMarked = isSkip
      ? !!entity.skipped
      : entity.reaction === "dislike";
    const state: PersonalStatePatch = normalizePersonalStatePatch(
      isSkip
        ? { skipped: !alreadyMarked }
        : { reaction: alreadyMarked ? "" : "dislike" },
    );
    const saving = update(kind, state);
    if (alreadyMarked) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    openFeedback({
      kind,
      cardKey: feedbackCardKey(collection, entity.id),
      container: event.currentTarget.closest("dialog") || document.body,
      x: event.detail ? event.clientX : bounds.left,
      y: event.detail ? event.clientY : bounds.top,
      title: "title" in entity ? String(entity.title) : "Мероприятие",
      reason: (isSkip ? entity.skipReason : entity.dislikeReason) || "",
      onDismiss: async () => {
        const marked = isSkip
          ? currentEntity.current.skipped
          : currentEntity.current.reaction === "dislike";
        if (!marked || !willHide(state)) return;
        onExitChange(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 118));
        onExitChange(false);
      },
      save: async (reason) => {
        if (!(await saving))
          throw new Error(
            isSkip
              ? "Пропуск не сохранился. Повторите на карточке."
              : "Оценка не сохранилась. Повторите дизлайк на карточке.",
          );
        return onSetState(
          currentEntity.current,
          isSkip ? { skipReason: reason } : { dislikeReason: reason },
        );
      },
    });
  };
  return (
    <div className="event-reactions" aria-label="Оценка мероприятия">
      <button
        className={`event-reaction-button like ${entity.reaction === "like" ? "active" : ""} ${pressed === "like" ? "is-confirming" : ""}`}
        aria-label={
          entity.reaction === "like"
            ? "Убрать отметку «Понравилось»"
            : "Понравилось"
        }
        aria-pressed={entity.reaction === "like"}
        disabled={!!pressed || pending}
        onClick={() =>
          void update("like", {
            reaction: entity.reaction === "like" ? "" : "like",
          })
        }
      >
        <ThumbsUp size={16} />
      </button>
      <button
        className={`event-reaction-button dislike ${entity.reaction === "dislike" ? "active" : ""} ${pressed === "dislike" ? "is-confirming" : ""}`}
        aria-label={
          entity.reaction === "dislike"
            ? "Убрать отметку «Не понравилось»"
            : "Не понравилось"
        }
        aria-pressed={entity.reaction === "dislike"}
        disabled={!!pressed || pending}
        onClick={(event) => rateWithFeedback(event, "dislike")}
      >
        <ThumbsDown size={16} />
      </button>
      <button
        className={`event-reaction-button favorite ${entity.favorite ? "active" : ""} ${pressed === "favorite" ? "is-confirming" : ""}`}
        aria-label={entity.favorite ? "Убрать из избранного" : "Хочу сходить"}
        title={entity.favorite ? "Убрать из избранного" : "Хочу сходить"}
        aria-pressed={entity.favorite}
        disabled={!!pressed || pending}
        onClick={() => void update("favorite", { favorite: !entity.favorite })}
      >
        <Star size={16} fill={entity.favorite ? "currentColor" : "none"} />
      </button>
      <button
        className={`event-reaction-button skip ${entity.skipped ? "active" : ""} ${pressed === "skip" ? "is-confirming" : ""}`}
        aria-label={
          entity.skipped ? "Убрать отметку «Пропущено»" : "Пропустить"
        }
        title={
          entity.skipped
            ? "Убрать отметку «Пропущено»"
            : "Пропустить (нейтрально)"
        }
        aria-pressed={!!entity.skipped}
        disabled={!!pressed || pending}
        onClick={(event) => rateWithFeedback(event, "skip")}
      >
        <svg
          className="skip-arrow-icon"
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M2 22C1 11 7.8 5.5 15 5.5V2.8Q15 2.1 15.6 2.6L23 8.4Q23.6 8.9 23 9.4L15.6 15.2Q15 15.7 15 15V12C8.9 12 4.5 15.6 2.4 22Q2.1 22.8 2 22Z" />
        </svg>
      </button>
    </div>
  );
}

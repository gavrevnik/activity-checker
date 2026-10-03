import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2 } from "lucide-react";
import { createFeedbackRetention } from "./feedback-retention";

interface FeedbackTarget {
  kind?: "dislike" | "skip";
  cardKey: string;
  container: HTMLElement;
  x: number;
  y: number;
  title: string;
  reason: string;
  save: (reason: string) => Promise<boolean>;
  onDismiss: () => Promise<void>;
}
interface FeedbackSession extends FeedbackTarget {
  key: number;
  closing: boolean;
  release: () => void;
}
const FeedbackContext = createContext<(target: FeedbackTarget) => void>(
  () => {},
);
const quickReasons = [
  "балканская персона",
  "актуально только местным",
  "мода/одежда/украшения",
  "не релевантная музыка",
] as const;
export const useDislikeFeedback = () => useContext(FeedbackContext);
const RetainedFeedbackContext = createContext<ReadonlySet<string>>(new Set());
export const useRetainedFeedbackCards = () =>
  useContext(RetainedFeedbackContext);

// Saving a rating and deciding when its card leaves the feed are independent.
export function DislikeFeedbackProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<FeedbackSession | null>(null);
  const active = useRef<FeedbackSession | null>(null);
  const [retained, setRetained] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const retention = useMemo(() => createFeedbackRetention(setRetained), []);
  const sequence = useRef(0);
  const finish = useCallback((session: FeedbackSession) => {
    if (session.closing) return;
    session.closing = true;
    if (active.current === session) {
      active.current = null;
      setTarget(null);
    }
    void Promise.resolve()
      .then(session.onDismiss)
      .catch(() => {})
      .finally(session.release);
  }, []);
  const open = useCallback(
    (next: FeedbackTarget) => {
      if (active.current) finish(active.current);
      const session: FeedbackSession = {
        ...next,
        key: ++sequence.current,
        closing: false,
        release: retention.hold(next.cardKey),
      };
      active.current = session;
      setTarget(session);
    },
    [finish, retention],
  );
  const [toast, setToast] = useState<{ key: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <FeedbackContext.Provider value={open}>
      <RetainedFeedbackContext.Provider value={retained}>
        {children}
        {target &&
          createPortal(
            <FeedbackInput
              key={target.key}
              target={target}
              close={() => finish(target)}
              saved={() => setToast({ key: ++sequence.current })}
            />,
            target.container,
          )}
        {toast &&
          createPortal(
            <div className="dislike-feedback-toast" role="status">
              <CheckCircle2 size={16} />
              Обратная связь записана
            </div>,
            document.querySelector("dialog[open]") || document.body,
          )}
      </RetainedFeedbackContext.Provider>
    </FeedbackContext.Provider>
  );
}

function FeedbackInput({
  target,
  close,
  saved,
}: {
  target: FeedbackTarget;
  close: () => void;
  saved: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const isSkip = target.kind === "skip";
  const feedbackLabel = isSkip ? "Причина пропуска" : "Причина дизлайка";
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [draft, setDraft] = useState(target.reason);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const width = Math.min(300, viewport.width - 16);
  const left = Math.max(
    8,
    Math.min(viewport.width - width - 8, target.x - width - 12),
  );
  const [top, setTop] = useState(() =>
    Math.max(8, Math.min(window.innerHeight - 210, target.y - 20)),
  );
  useLayoutEffect(() => {
    const height = box.current?.getBoundingClientRect().height || 0;
    setTop(Math.max(8, Math.min(viewport.height - height - 8, target.y - 20)));
  }, [error, pending, target.y, viewport]);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const outside = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !box.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("click", outside, true); // Also handles keyboard activation outside the input.
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("click", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [close]);
  const submit = async (value = draft) => {
    if (saving.current) return;
    const reason = value.trim();
    // Empty feedback is optional; Enter does not invent a successful write.
    if (!reason && !target.reason) {
      close();
      return;
    }
    saving.current = true;
    setPending(true);
    setError("");
    try {
      if (await target.save(reason)) {
        saved();
        close();
      } else
        setError(
          "Не удалось записать причину. Нажмите Enter, чтобы повторить.",
        );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Не удалось записать причину. Нажмите Enter, чтобы повторить.",
      );
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  return (
    <div
      ref={box}
      className="dislike-feedback"
      style={{ left, top, width }}
      role="dialog"
      aria-label={feedbackLabel}
      aria-busy={pending || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Only submission or an outside action resolves this feedback.
          // Do not let Escape cancel an enclosing native card dialog either.
          event.preventDefault();
        }
      }}
    >
      <label htmlFor="dislike-feedback-input">
        {isSkip ? "Почему пропускаете?" : "Почему не понравилось?"}
      </label>
      <input
        id="dislike-feedback-input"
        ref={input}
        value={draft}
        maxLength={2000}
        aria-label={feedbackLabel}
        placeholder="Необязательно"
        readOnly={pending}
        title={target.title}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div
        className="dislike-feedback-chips"
        role="group"
        aria-label={
          isSkip ? "Быстрые причины пропуска" : "Быстрые причины отказа"
        }
      >
        {(isSkip ? ["дубль"] : quickReasons).map((reason) => (
          <button
            type="button"
            key={reason}
            disabled={pending}
            onClick={() => {
              setDraft(reason);
              void submit(reason);
            }}
          >
            {reason}
          </button>
        ))}
      </div>
      {pending && <small role="status">Записываем…</small>}
      {error && (
        <small className="dislike-feedback-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

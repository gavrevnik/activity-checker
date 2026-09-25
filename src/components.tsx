import { useEffect, useRef, type ReactNode } from "react";
import {
  X,
  ArrowUpRight,
  Loader2,
  CalendarDays,
  MapPin,
  Users,
  Building2,
} from "lucide-react";
import type { EntityType, SyncResult } from "../shared/model";
export const icons = {
  Event: CalendarDays,
  Place: MapPin,
  Community: Users,
  Organizer: Building2,
};
export function TypeIcon({
  type,
  size = 18,
}: {
  type: EntityType;
  size?: number;
}) {
  const Icon = icons[type];
  return <Icon size={size} />;
}
export function Button({
  children,
  onClick,
  disabled,
  primary = false,
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`button ${primary ? "primary" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
export function External({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  return href && (/^(https?:\/\/)/i.test(href) || href.startsWith("/api/")) ? (
    <a className="external" href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : null;
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  drawer = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${wide ? "wide" : ""} ${drawer ? "drawer" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Busy() {
  return <Loader2 size={15} className="spin" aria-label="Выполняется" />;
}
export function Stats({ result }: { result: SyncResult }) {
  return (
    <div className="sync-stats">
      <span>
        Получено <b>{result.fetched}</b>
      </span>
      <span>
        Новых <b>{result.created}</b>
      </span>
      <span>
        Обновлено <b>{result.updated}</b>
      </span>
      <span>
        Повторных <b>{result.duplicates}</b>
      </span>
      <span className={result.errors ? "error-text" : ""}>
        Ошибок <b>{result.errors}</b>
      </span>
    </div>
  );
}
export const audiences: Record<string, string> = {
  all: "Любая аудитория",
  "russian-speaking": "Русскоязычная",
  international: "Международная",
  local: "Местная",
};

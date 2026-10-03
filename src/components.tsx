import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  X,
  ArrowUpRight,
  Loader2,
  CalendarDays,
  MapPin,
  Users,
  ChevronDown,
} from "lucide-react";
import type { EntityType, SyncResult } from "../shared/model";
export const icons = {
  Event: CalendarDays,
  Place: MapPin,
  Community: Users,
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
export interface CheckboxMultiSelectOption {
  value: string;
  label: string;
  count?: number;
}
export function CheckboxMultiSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: CheckboxMultiSelectOption[];
  value: string[] | null;
  onChange: (value: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const selected = new Set(value ?? options.map((option) => option.value));
  const summary =
    value === null
      ? allLabel
      : value.length === 0
        ? "Ничего не выбрано"
        : value.length === 1
          ? options.find((option) => option.value === value[0])?.label ||
            "1 выбрано"
          : `${value.length} выбрано`;
  const toggle = (optionValue: string) => {
    const next = new Set(selected);
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    const nextValues = options
      .map((option) => option.value)
      .filter((candidate) => next.has(candidate));
    onChange(nextValues.length === options.length ? null : nextValues);
  };
  return (
    <div className={`checkbox-multiselect ${open ? "is-open" : ""}`} ref={root}>
      <button
        type="button"
        className="checkbox-multiselect-trigger"
        aria-label={`${label}: ${summary}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <strong>{summary}</strong>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="checkbox-multiselect-menu"
          role="listbox"
          aria-multiselectable="true"
        >
          <label className="checkbox-multiselect-all">
            <input
              type="checkbox"
              checked={value === null}
              onChange={() => onChange(value === null ? [] : null)}
            />
            <span>Выбрать все</span>
          </label>
          <div className="checkbox-multiselect-options">
            {options.map((option) => (
              <label key={option.value}>
                <input
                  type="checkbox"
                  checked={selected.has(option.value)}
                  onChange={() => toggle(option.value)}
                />
                <span>{option.label}</span>
                {option.count !== undefined && <small>{option.count}</small>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
      <span>
        Отфильтровано <b>{result.filtered}</b>
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

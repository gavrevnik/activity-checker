import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  calendarDays,
  dateRangeCaption,
  orderedDateRange,
  isCalendarDaySelectable,
  shiftCalendarMonth,
  quickDatePeriods,
} from "./date-range-calendar";
import "./date-range-filter.css";

const presets = [
  ["", "Все даты"],
  ["today", "Сегодня"],
  ...quickDatePeriods,
] as const;
const fullDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const monthLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

export function DateRangeFilter({
  from,
  to,
  today,
  period,
  onRange,
  onPeriod,
}: {
  from: string;
  to: string;
  today: string;
  period: string;
  onRange: (from: string, to: string) => void;
  onPeriod: (period: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(today);
  const [first, setFirst] = useState("");
  const [hovered, setHovered] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("[data-initial-day]")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const finish = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const preview = first
    ? orderedDateRange(first, hovered || first)
    : { from, to };
  const caption = dateRangeCaption(from, to);
  const initialDay =
    from && isCalendarDaySelectable(from, today) ? from : today;
  return (
    <div
      ref={root}
      className={`date-range-filter ${open ? "is-open" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          finish();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="checkbox-multiselect-trigger"
        aria-label={caption ? `Даты: ${caption}` : "Даты"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (!open) {
            setMonth(initialDay);
            setFirst("");
            setHovered("");
          }
          setOpen(!open);
        }}
      >
        <span>Даты</span>
        {caption && <strong>{caption}</strong>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="dialog"
          aria-label="Выбор диапазона дат"
          className="date-range-menu"
        >
          <div className="date-range-month">
            <button
              type="button"
              aria-label="Предыдущий месяц"
              onClick={() => setMonth(shiftCalendarMonth(month, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <strong aria-live="polite">
              {monthLabel.format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`))}
            </strong>
            <button
              type="button"
              aria-label="Следующий месяц"
              onClick={() => setMonth(shiftCalendarMonth(month, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <p className="date-range-hint" aria-live="polite">
            {first ? "Выберите конечную дату" : "Выберите первую дату"}
          </p>
          <div className="date-range-grid">
            {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
              <span key={day} className="date-range-weekday">
                {day}
              </span>
            ))}
            {calendarDays(month).map((day) => {
              const selectable = isCalendarDaySelectable(day, today);
              const edge = day === preview.from || day === preview.to;
              const inRange =
                !!preview.from && day >= preview.from && day <= preview.to;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!selectable}
                  aria-label={fullDate.format(new Date(`${day}T12:00:00Z`))}
                  aria-pressed={inRange}
                  aria-current={day === today ? "date" : undefined}
                  data-initial-day={day === initialDay ? "" : undefined}
                  className={[
                    day.slice(0, 7) !== month.slice(0, 7)
                      ? "outside-month"
                      : "",
                    edge ? "range-edge" : "",
                    inRange ? "in-range" : "",
                  ].join(" ")}
                  onMouseEnter={() => {
                    if (selectable) setHovered(day);
                  }}
                  onClick={() => {
                    if (!selectable) return;
                    if (!first || !isCalendarDaySelectable(first, today)) {
                      setFirst(day);
                      setHovered(day);
                    } else {
                      const range = orderedDateRange(first, day);
                      onRange(range.from, range.to);
                      finish();
                    }
                  }}
                >
                  {Number(day.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="date-range-presets">
            {presets.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value && (!from || value !== "")}
                onClick={() => {
                  onPeriod(value);
                  finish();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="date-range-actions">
            <button
              type="button"
              onClick={() => {
                setFirst("");
                setHovered("");
                onPeriod("");
                finish();
              }}
            >
              Сбросить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

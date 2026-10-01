import { useEffect, useState } from "react";
import {
  CalendarX2,
  MapPinOff,
  Save,
  SearchX,
  Tags,
  TicketX,
  UsersRound,
} from "lucide-react";
import type {
  FilteringRules as FilteringRulesValue,
  FilteringRulesView,
} from "../shared/model";
import { Busy, Button } from "./components";

const formatTerms = (terms: string[]) => terms.join(", ");
const parseTerms = (value: string) => {
  const seen = new Set<string>();
  return value
    .split(/[,\n]/u)
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLocaleLowerCase();
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};
const draftsFrom = (rules: FilteringRulesValue) => ({
  ticketVenues: formatTerms(rules.ticketsVenue.venues),
  ticketKeywords: formatTerms(rules.ticketsVenue.keywords),
  ticketTitleKeywords: formatTerms(rules.ticketsVenue.titleKeywords),
  titleKeywords: formatTerms(rules.eventTitle.keywords),
  locationKeywords: formatTerms(rules.eventLocation.keywords),
  tagKeywords: formatTerms(rules.entityTags.keywords),
});

export function FilteringRules({
  value,
  busy,
  onSave,
}: {
  value: FilteringRulesView;
  busy: boolean;
  onSave: (rules: FilteringRulesValue) => void;
}) {
  const [rules, setRules] = useState(value.rules);
  const [drafts, setDrafts] = useState(() => draftsFrom(value.rules));
  useEffect(() => {
    setRules(value.rules);
    setDrafts(draftsFrom(value.rules));
  }, [value]);
  const update = <K extends keyof FilteringRulesValue>(
    key: K,
    patch: Partial<FilteringRulesValue[K]>,
  ) =>
    setRules((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
  return (
    <section className="filter-rules-page">
      <div className="filter-rules-intro">
        <div>
          <h2>Статичные правила</h2>
          <p>
            Они выполняются после получения и нормализации каждой записи.
            Исходные данные остаются в базе: отключённое или изменённое правило
            немедленно возвращает подходящие карточки.
          </p>
        </div>
        <span className="count">Скрыто: {value.counts.total}</span>
      </div>
      <div className="filter-rules-grid">
        <article className="filter-rule-card">
          <header>
            <CalendarX2 size={20} />
            <div>
              <h3>Прошлые события</h3>
              <p>Скрывать события, дата завершения которых уже прошла.</p>
            </div>
            <label className="rule-switch">
              <input
                type="checkbox"
                checked={rules.pastEvents.enabled}
                onChange={(event) =>
                  update("pastEvents", { enabled: event.target.checked })
                }
              />
              {rules.pastEvents.enabled ? "Включено" : "Выключено"}
            </label>
          </header>
          <small>Сейчас скрыто: {value.counts.pastEvents}</small>
        </article>

        <article className="filter-rule-card">
          <header>
            <UsersRound size={20} />
            <div>
              <h3>Размер Telegram-сообщества</h3>
              <p>
                Скрывать небольшие каналы и группы. Если размер не получен,
                запись пропускается без фильтрации.
              </p>
            </div>
            <label className="rule-switch">
              <input
                type="checkbox"
                checked={rules.telegramMinMembers.enabled}
                onChange={(event) =>
                  update("telegramMinMembers", {
                    enabled: event.target.checked,
                  })
                }
              />
              {rules.telegramMinMembers.enabled ? "Включено" : "Выключено"}
            </label>
          </header>
          <div className="rule-controls">
            <label>
              Минимум участников
              <input
                type="number"
                min="0"
                max="10000000"
                value={rules.telegramMinMembers.minMembers}
                onChange={(event) =>
                  update("telegramMinMembers", {
                    minMembers: Math.max(0, Number(event.target.value) || 0),
                  })
                }
              />
            </label>
            <small>Сейчас скрыто: {value.counts.telegramMinMembers}</small>
          </div>
        </article>

        <article className="filter-rule-card">
          <header>
            <TicketX size={20} />
            <div>
              <h3>Tickets.rs: площадка и название</h3>
              <p>
                Скрывать события Tickets.rs по точным названиям площадок или
                отдельным ключевикам площадки и названия события. Сравнение не
                зависит от регистра и диакритики.
              </p>
            </div>
            <label className="rule-switch">
              <input
                type="checkbox"
                checked={rules.ticketsVenue.enabled}
                onChange={(event) =>
                  update("ticketsVenue", { enabled: event.target.checked })
                }
              />
              {rules.ticketsVenue.enabled ? "Включено" : "Выключено"}
            </label>
          </header>
          <div className="rule-controls">
            <label>
              Точные названия — через запятую или с новой строки
              <textarea
                rows={2}
                value={drafts.ticketVenues}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    ticketVenues: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Ключевики площадки — через запятую или с новой строки
              <textarea
                rows={2}
                value={drafts.ticketKeywords}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    ticketKeywords: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Ключевики названия — через запятую или с новой строки
              <textarea
                rows={2}
                value={drafts.ticketTitleKeywords}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    ticketTitleKeywords: event.target.value,
                  }))
                }
              />
            </label>
            <small>Сейчас скрыто: {value.counts.ticketsVenue}</small>
          </div>
        </article>

        <article className="filter-rule-card">
          <header>
            <SearchX size={20} />
            <div>
              <h3>Название события</h3>
              <p>
                Скрывать события любого источника, если название содержит один
                из ключевиков. Сравнение не зависит от регистра и диакритики.
              </p>
            </div>
            <label className="rule-switch">
              <input
                type="checkbox"
                checked={rules.eventTitle.enabled}
                onChange={(event) =>
                  update("eventTitle", { enabled: event.target.checked })
                }
              />
              {rules.eventTitle.enabled ? "Включено" : "Выключено"}
            </label>
          </header>
          <div className="rule-controls">
            <label>
              Ключевики — через запятую или с новой строки
              <textarea
                rows={2}
                value={drafts.titleKeywords}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    titleKeywords: event.target.value,
                  }))
                }
              />
            </label>
            <small>Сейчас скрыто: {value.counts.eventTitle}</small>
          </div>
        </article>

        <article className="filter-rule-card">
          <header>
            <MapPinOff size={20} />
            <div>
              <h3>Локация события</h3>
              <p>
                Скрывать события любого источника, если площадка или адрес
                содержит один из ключевиков.
              </p>
            </div>
            <label className="rule-switch">
              <input
                type="checkbox"
                checked={rules.eventLocation.enabled}
                onChange={(event) =>
                  update("eventLocation", { enabled: event.target.checked })
                }
              />
              {rules.eventLocation.enabled ? "Включено" : "Выключено"}
            </label>
          </header>
          <div className="rule-controls">
            <label>
              Ключевики — через запятую или с новой строки
              <textarea
                rows={2}
                value={drafts.locationKeywords}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    locationKeywords: event.target.value,
                  }))
                }
              />
            </label>
            <small>Сейчас скрыто: {value.counts.eventLocation}</small>
          </div>
        </article>

        <article className="filter-rule-card">
          <header>
            <Tags size={20} />
            <div>
              <h3>Теги активности</h3>
              <p>
                Скрывать карточки любого типа, если один из тегов содержит
                заданный ключевик. Символ # можно указывать или пропускать.
              </p>
            </div>
            <label className="rule-switch">
              <input
                type="checkbox"
                checked={rules.entityTags.enabled}
                onChange={(event) =>
                  update("entityTags", { enabled: event.target.checked })
                }
              />
              {rules.entityTags.enabled ? "Включено" : "Выключено"}
            </label>
          </header>
          <div className="rule-controls">
            <label>
              Ключевики тегов — через запятую или с новой строки
              <textarea
                rows={2}
                value={drafts.tagKeywords}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    tagKeywords: event.target.value,
                  }))
                }
              />
            </label>
            <small>Сейчас скрыто: {value.counts.entityTags}</small>
          </div>
        </article>
      </div>
      <div className="filter-rules-actions">
        <Button
          primary
          disabled={busy}
          onClick={() =>
            onSave({
              ...rules,
              ticketsVenue: {
                ...rules.ticketsVenue,
                venues: parseTerms(drafts.ticketVenues),
                keywords: parseTerms(drafts.ticketKeywords),
                titleKeywords: parseTerms(drafts.ticketTitleKeywords),
              },
              eventTitle: {
                ...rules.eventTitle,
                keywords: parseTerms(drafts.titleKeywords),
              },
              eventLocation: {
                ...rules.eventLocation,
                keywords: parseTerms(drafts.locationKeywords),
              },
              entityTags: {
                ...rules.entityTags,
                keywords: parseTerms(drafts.tagKeywords),
              },
            })
          }
        >
          {busy ? <Busy /> : <Save size={15} />}
          Сохранить и применить
        </Button>
      </div>
    </section>
  );
}

import { useState } from "react";
import { Check, Copy, Download, Upload, ArrowRight } from "lucide-react";
import {
  categories,
  entitySchema,
  entityTypes,
  typeLabels,
  type Entity,
  type EntityInput,
  type ProviderInfo,
  type Scope,
  type SourceView,
  type SourceInput,
  type SyncResult,
} from "../shared/model";
import { api } from "./api";
import { localDateTime, parseCalendarInput } from "../shared/dates";
import {
  Button,
  Modal,
  Field,
  Busy,
  Stats,
  External,
  audiences,
} from "./components";
export function EntityForm({
  entity,
  scope,
  onClose,
  onSaved,
}: {
  entity?: Entity;
  scope: Scope;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<any>(
      entity
        ? Object.fromEntries(
            Object.keys(entitySchema.shape).map((k) => [k, (entity as any)[k]]),
          )
        : {
            type: "Event",
            title: "",
            country: scope.country,
            city: scope.city || "",
            category: "Другое",
            audience: "all",
          },
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setValues((s: any) => ({ ...s, [k]: v }));
  const input = (k: string, props: Record<string, any> = {}) => (
    <input
      value={values[k] ?? ""}
      onChange={(e) => set(k, e.target.value)}
      {...props}
    />
  );
  const initialDates = () =>
    Object.fromEntries(
      ["startAt", "endAt"].map((key) => {
        const local = localDateTime(values[key] || "", scope.timezone),
          date = local.slice(0, 10);
        return [
          key,
          {
            day: date ? date.split("-").reverse().join(".") : "",
            time: local.slice(11, 16),
          },
        ];
      }),
    );
  const [dateDrafts, setDateDrafts] = useState(initialDates);
  const dateInput = (key: string, label: string) => (
    <div className="field">
      <span>{label}</span>
      <div className="date-input">
        <input
          aria-label={label + ": дата"}
          placeholder="ДД.ММ.ГГГГ"
          inputMode="numeric"
          value={dateDrafts[key].day}
          onChange={(e) =>
            setDateDrafts((d) => ({
              ...d,
              [key]: { ...d[key], day: e.target.value },
            }))
          }
        />
        <input
          aria-label={label + ": время"}
          className="time-input"
          placeholder="ЧЧ:ММ"
          inputMode="numeric"
          value={dateDrafts[key].time}
          onChange={(e) =>
            setDateDrafts((d) => ({
              ...d,
              [key]: { ...d[key], time: e.target.value },
            }))
          }
        />
      </div>
      <small>Время необязательно · {scope.timezone}</small>
    </div>
  );
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const dates: Record<string, string> = {};
      if (values.type === "Event")
        for (const key of ["startAt", "endAt"]) {
          const draft = dateDrafts[key],
            initial = initialDates()[key];
          dates[key] =
            draft.day === initial.day && draft.time === initial.time
              ? values[key] || ""
              : parseCalendarInput(draft.day, draft.time, scope.timezone);
        }
      const data = entitySchema.parse({ ...values, ...dates });
      await api(
        entity ? "/entities/" + entity.id : "/entities",
        entity ? "PUT" : "POST",
        data,
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={entity ? "Редактировать активность" : "Добавить активность"}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Тип">
            <select
              value={values.type}
              disabled={!!entity}
              onChange={(e) => set("type", e.target.value)}
            >
              {entityTypes.map((t) => (
                <option key={t} value={t}>
                  {typeLabels[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Категория">
            <select
              value={values.category}
              onChange={(e) => set("category", e.target.value)}
            >
              {[...new Set([...categories, values.category])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <div className="full">
            <Field label="Название *">
              {input("title", {
                required: true,
                maxLength: 400,
                autoFocus: true,
              })}
            </Field>
          </div>
          <div className="full">
            <Field label="Описание">
              <textarea
                rows={4}
                value={values.description || ""}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Страна · ISO 2">
            {input("country", { required: true, maxLength: 2 })}
          </Field>
          <Field label="Город">
            {input("city", { placeholder: "Belgrade" })}
          </Field>
          {values.type === "Event" && (
            <>
              {dateInput("startAt", "Начало")}
              {dateInput("endAt", "Окончание")}
              <Field label="Площадка">{input("venue")}</Field>
              <Field label="Стоимость">
                {input("price", { placeholder: "Например, 1 500 RSD" })}
              </Field>
            </>
          )}
          <Field label="Адрес">{input("address")}</Field>
          <Field label="Ссылка на оригинал">
            {input("url", { type: "url", placeholder: "https://…" })}
          </Field>
          <Field label="Сайт">
            {input("website", { type: "url", placeholder: "https://…" })}
          </Field>
          <Field label="Теги · через запятую">
            <input
              value={(values.tags || []).join(", ")}
              onChange={(e) =>
                set(
                  "tags",
                  e.target.value.split(",").map((s) => s.trimStart()),
                )
              }
            />
          </Field>
        </div>
        <details className="form-extra">
          <summary>Язык, контакты и дополнительные поля</summary>
          <div className="form-grid">
            <Field label="Языки · ru, en, sr">
              <input
                value={(values.languages || []).join(", ")}
                onChange={(e) =>
                  set(
                    "languages",
                    e.target.value.split(",").map((s) => s.trimStart()),
                  )
                }
              />
            </Field>
            <Field label="Аудитория">
              <select
                value={values.audience}
                onChange={(e) => set("audience", e.target.value)}
              >
                {Object.entries(audiences).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Телефон">{input("phone", { type: "tel" })}</Field>
            <Field label="Часы работы">{input("openingHours")}</Field>
            <Field label="Изображение · URL">
              {input("imageUrl", { type: "url" })}
            </Field>
            <Field label="ID внешней записи">{input("externalId")}</Field>
            <Field label="Широта">
              <input
                type="number"
                step="any"
                value={values.latitude ?? ""}
                onChange={(e) =>
                  set(
                    "latitude",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              />
            </Field>
            <Field label="Долгота">
              <input
                type="number"
                step="any"
                value={values.longitude ?? ""}
                onChange={(e) =>
                  set(
                    "longitude",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
              />
            </Field>
          </div>
        </details>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-footer">
          <Button onClick={onClose}>Отмена</Button>
          <Button primary type="submit" disabled={busy}>
            {busy && <Busy />}Сохранить
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
export function SourceForm({
  source,
  providers,
  scopes,
  scope,
  onClose,
  onSaved,
}: {
  source?: SourceView;
  providers: ProviderInfo[];
  scopes: Scope[];
  scope: Scope;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<SourceInput>(
      source
        ? {
            providerId: source.providerId,
            name: source.name,
            url: source.url,
            scopeId: source.scopeId,
            enabled: source.enabled,
            language: source.language,
            audience: source.audience,
            categories: source.categories,
            notes: source.notes,
            priority: source.priority,
            format: source.format,
            keyword: source.keyword,
          }
        : {
            providerId: "structured",
            name: "",
            url: "",
            scopeId: scope.id,
            enabled: true,
            format: "auto",
            priority: 50,
          },
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const provider = providers.find((p) => p.id === values.providerId)!;
  const set = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(
        source ? "/sources/" + source.id : "/sources",
        source ? "PUT" : "POST",
        values,
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={source ? "Настроить источник" : "Добавить источник"}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Провайдер">
            <select
              value={values.providerId}
              disabled={!!source}
              onChange={(e) => {
                const p = providers.find((p) => p.id === e.target.value)!;
                setValues((v) => ({
                  ...v,
                  providerId: p.id,
                  url: p.defaultUrl || "",
                  name: p.name,
                }));
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {!p.implemented ? " · заготовка" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="География">
            <select
              value={values.scopeId}
              onChange={(e) => set("scopeId", e.target.value)}
            >
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="full">
            <Field label="Название *">
              <input
                required
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
          </div>
          <div className="full">
            <Field label="URL профиля, сайта или ленты">
              <input
                type="url"
                placeholder="https://…"
                value={values.url}
                onChange={(e) => set("url", e.target.value)}
              />
            </Field>
          </div>
          {provider.providerType === "Website/Aggregator" && (
            <Field label="Формат">
              <select
                value={values.format}
                onChange={(e) => set("format", e.target.value)}
              >
                {["auto", "jsonld", "rss", "ics", "json"].map((v) => (
                  <option key={v} value={v}>
                    {v === "auto"
                      ? "Определить автоматически"
                      : v.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {provider.id === "ticketmaster" && (
            <Field label="Ключевое слово">
              <input
                value={values.keyword || ""}
                onChange={(e) => set("keyword", e.target.value)}
              />
            </Field>
          )}
          <Field label="Язык источника">
            <input
              placeholder="ru / en / sr"
              value={values.language || ""}
              onChange={(e) => set("language", e.target.value)}
            />
          </Field>
          <Field label="Аудитория">
            <select
              value={values.audience || "all"}
              onChange={(e) => set("audience", e.target.value)}
            >
              {Object.entries(audiences).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Категории · через запятую">
            <input
              value={(values.categories || []).join(", ")}
              onChange={(e) =>
                set(
                  "categories",
                  e.target.value.split(",").map((s) => s.trimStart()),
                )
              }
            />
          </Field>
          <Field label="Приоритет · 0–100">
            <input
              type="number"
              min={0}
              max={100}
              value={values.priority}
              onChange={(e) => set("priority", Number(e.target.value))}
            />
          </Field>
          <div className="full">
            <Field label="Заметка">
              <textarea
                rows={2}
                value={values.notes || ""}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
        </div>
        <label className="checkbox enable-source">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          Включить источник
        </label>
        <div className="setup-box">
          <h3>
            {provider.implemented ? "Подключение" : "Адаптер ещё не реализован"}
          </h3>
          <ol>
            {provider.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {provider.credentials.length > 0 && (
            <pre>{provider.credentials.map((c) => c.key + "=").join("\n")}</pre>
          )}
          <div className="doc-links">
            {provider.docs.map((d) => (
              <External key={d.url} href={d.url}>
                {d.label}
              </External>
            ))}
          </div>
          <p>{provider.limitations}</p>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-footer">
          <Button onClick={onClose}>Отмена</Button>
          <Button primary type="submit" disabled={busy}>
            {busy && <Busy />}Сохранить
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
const sample = JSON.stringify(
  {
    version: 1,
    entities: [
      {
        type: "Place",
        title: "Название места",
        country: "RS",
        city: "Belgrade",
        category: "Спорт",
        url: "https://example.org/place",
        tags: ["climbing"],
      },
    ],
  },
  null,
  2,
);
const prompt =
  'Найди реальные актуальные события, места, сообщества и организаторов в Белграде / Сербии. Проверь первоисточники. Для сообществ приоритет: русскоязычные, затем международные/expat, затем местные. Верни только JSON {"version":1,"entities":[...]}. Поля: type (Event|Place|Community|Organizer), title, description, country (RS), city (Belgrade или реальный город), category, tags (массив), languages (массив ru/en/sr), audience (all|russian-speaking|international|local), startAt/endAt (ISO 8601 с часовым поясом либо YYYY-MM-DD; только если подтверждено), venue, address, url (первоисточник конкретной записи), website, price, phone, externalId (стабильный ID если известен). Не выдумывай даты, контакты, цены и ссылки. Не добавляй неизвестные поля. Все URL только HTTP(S). Если данных нет, опусти поле.';
export function ImportForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<{
      result: SyncResult;
      entities: EntityInput[];
      total: number;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function run(commit = false) {
    setBusy(true);
    setError("");
    try {
      const result = await api<typeof preview>(
        commit ? "/import" : "/import/preview",
        "POST",
        { text },
      );
      if (commit) {
        await onSaved();
        onClose();
      } else setPreview(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Импорт JSON" onClose={onClose} wide>
      <div className="import-tools">
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(prompt);
              setCopied(true);
            } catch {
              setError("Не удалось скопировать. Промпт доступен в README.");
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}Промпт для чата
        </Button>
        <Button
          onClick={() => {
            setText(sample);
            setPreview(null);
          }}
        >
          Пример JSON
        </Button>
        <a
          className="button"
          href="/api/import/schema"
          target="_blank"
          rel="noreferrer"
        >
          <Download size={14} />
          JSON Schema
        </a>
        <label className="button file-input">
          <Upload size={14} />
          Файл
          <input
            type="file"
            accept=".json,application/json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                if (file.size > 5 * 1024 * 1024) {
                  setError("Максимальный размер файла — 5 МБ.");
                  return;
                }
                setText(await file.text());
                setPreview(null);
              }
            }}
          />
        </label>
      </div>
      <p className="muted import-hint">
        Массив записей или объект с полем entities. Весь пакет проверяется до
        сохранения.
      </p>
      <textarea
        className="json-editor"
        aria-label="JSON для импорта"
        spellCheck={false}
        placeholder={'{ "version": 1, "entities": […] }'}
        rows={12}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
          setError("");
        }}
      />
      {preview && (
        <div className="import-preview">
          <h3>Предпросмотр · {preview.total} записей</h3>
          <Stats result={preview.result} />
          <div className="preview-list">
            {preview.entities.map((e, i) => (
              <div key={i}>
                <span className="badge">{e.type}</span>
                <span>{e.title}</span>
                <small>{e.city}</small>
              </div>
            ))}
          </div>
          {preview.total > 25 && <small>Показаны первые 25 записей.</small>}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="dialog-footer">
        <Button onClick={onClose}>Отмена</Button>
        {preview ? (
          <Button primary disabled={busy} onClick={() => run(true)}>
            {busy ? <Busy /> : <Check size={15} />}Импортировать {preview.total}
          </Button>
        ) : (
          <Button primary disabled={busy || !text.trim()} onClick={() => run()}>
            {busy ? <Busy /> : <ArrowRight size={15} />}Проверить
          </Button>
        )}
      </footer>
    </Modal>
  );
}

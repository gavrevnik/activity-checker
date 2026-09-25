import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Pencil,
  Star,
  Phone,
  MapPin,
  CalendarDays,
  Link,
  Copy,
  Plus,
  Check,
} from "lucide-react";
import type { Entity, EntityDetail } from "../shared/model";
import { typeLabels } from "../shared/model";
import { displayDate } from "../shared/dates";
import { api } from "./api";
import {
  Modal,
  Button,
  Busy,
  TypeIcon,
  External,
  audiences,
} from "./components";
export function Detail({
  id,
  entities,
  onClose,
  onEdit,
  onChanged,
  onOpen,
}: {
  id: string;
  entities: Entity[];
  onClose: () => void;
  onEdit: (e: Entity) => void;
  onChanged: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [entity, setEntity] = useState<EntityDetail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notes, setNotes] = useState(""),
    [merge, setMerge] = useState(""),
    [related, setRelated] = useState(""),
    [relation, setRelation] = useState("associated");
  async function reload() {
    const e = await api<EntityDetail>("/entities/" + id);
    setEntity(e);
    setNotes(e.notes);
  }
  useEffect(() => {
    let cancelled = false;
    setEntity(null);
    setError("");
    setMerge("");
    api<EntityDetail>("/entities/" + id)
      .then((e) => {
        if (!cancelled) {
          setEntity(e);
          setNotes(e.notes);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  async function action(path: string, method: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, method, body);
      await onChanged();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Активность" onClose={onClose} drawer>
      {entity ? (
        <>
          <div className="detail-title">
            <span className={"type-symbol " + entity.type.toLowerCase()}>
              <TypeIcon type={entity.type} size={24} />
            </span>
            <div>
              <div className="detail-kicker">
                {typeLabels[entity.type]}
                {entity.demo && <span className="badge demo">Демо</span>}
                {entity.archived && <span className="badge">Архив</span>}
              </div>
              <h2>{entity.title}</h2>
            </div>
            <button
              className={`icon-button favorite ${entity.favorite ? "is-favorite" : ""}`}
              aria-label="Избранное"
              disabled={busy}
              onClick={() =>
                action("/entities/" + id, "PATCH", {
                  favorite: !entity.favorite,
                })
              }
            >
              <Star
                size={19}
                fill={entity.favorite ? "currentColor" : "none"}
              />
            </button>
          </div>
          <div className="detail-actions">
            <Button onClick={() => onEdit(entity)}>
              <Pencil size={14} />
              Редактировать
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action("/entities/" + id, "PATCH", {
                  archived: !entity.archived,
                })
              }
            >
              {entity.archived ? (
                <ArchiveRestore size={14} />
              ) : (
                <Archive size={14} />
              )}{" "}
              {entity.archived ? "Восстановить" : "В архив"}
            </Button>
            <External href={entity.url}>Первоисточник</External>
          </div>
          {entity.imageUrl && (
            <img
              className="detail-image"
              src={entity.imageUrl}
              alt=""
              referrerPolicy="no-referrer"
            />
          )}
          <div className="detail-facts">
            {entity.type === "Event" && (
              <div>
                <CalendarDays size={17} />
                <span>
                  {entity.startAt
                    ? displayDate(
                        entity.startAt,
                        entity.startAt.length > 10
                          ? {
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            }
                          : { year: "numeric" },
                      )
                    : "Дата уточняется"}
                  {entity.endAt &&
                    " — " +
                      displayDate(entity.endAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                  <small>Europe/Belgrade</small>
                </span>
              </div>
            )}
            <div>
              <MapPin size={17} />
              <span>
                {[entity.venue, entity.address, entity.city, entity.country]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {entity.price && (
              <div>
                <span className="fact-label">Цена</span>
                <span>{entity.price}</span>
              </div>
            )}
            {entity.openingHours && (
              <div>
                <span className="fact-label">Часы</span>
                <span>{entity.openingHours}</span>
              </div>
            )}
            {entity.languages.length > 0 && (
              <div>
                <span className="fact-label">Языки</span>
                <span>
                  {entity.languages.join(" / ")} · {audiences[entity.audience]}
                </span>
              </div>
            )}
          </div>
          <p className="detail-description">
            {entity.description || "Описание пока не добавлено."}
          </p>
          <div className="detail-tags">
            <span className="badge">{entity.category}</span>
            {entity.tags.map((t) => (
              <span className="badge" key={t}>
                #{t}
              </span>
            ))}
          </div>
          <div className="doc-links detail-links">
            <External href={entity.website}>Сайт</External>
            {entity.phone && (
              <a
                className="external"
                href={"tel:" + entity.phone.replace(/[^\d+]/g, "")}
              >
                <Phone size={13} />
                {entity.phone}
              </a>
            )}
            {entity.latitude != null && entity.longitude != null && (
              <External
                href={`https://www.openstreetmap.org/?mlat=${entity.latitude}&mlon=${entity.longitude}#map=17/${entity.latitude}/${entity.longitude}`}
              >
                На карте
              </External>
            )}
          </div>
          <section className="detail-section">
            <h3>Заметка</h3>
            <textarea
              aria-label="Личная заметка"
              placeholder="Что хочется попробовать или проверить"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            {notes !== entity.notes && (
              <Button
                disabled={busy}
                onClick={() => action("/entities/" + id, "PATCH", { notes })}
              >
                Сохранить заметку
              </Button>
            )}
          </section>
          {entity.duplicates.length > 0 && (
            <section className="detail-section">
              <h3>
                <Copy size={15} />
                Возможные дубликаты
              </h3>
              {entity.duplicates.map((d) => (
                <div className="duplicate-row" key={d.id}>
                  <button className="text-button" onClick={() => onOpen(d.id)}>
                    {d.title}
                  </button>
                  <p>{d.reason}</p>
                  <div className="actions">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        action(
                          "/entities/" + id + "/duplicates/ignore",
                          "POST",
                          { otherId: d.id },
                        )
                      }
                    >
                      Разные записи
                    </Button>
                    <Button onClick={() => setMerge(d.id)}>Объединить</Button>
                  </div>
                </div>
              ))}
            </section>
          )}
          <section className="detail-section">
            <h3>
              <Link size={15} />
              Связанные записи
            </h3>
            {entity.related.map((r, i) => (
              <button
                className="related-record"
                key={r.id + i}
                onClick={() => onOpen(r.id)}
              >
                <TypeIcon type={r.type} size={15} />
                {r.title}
                <small>
                  {
                    (
                      {
                        hosts: "площадка",
                        organizes: "организация",
                        recommends: "рекомендация",
                        associated: "связь",
                      } as Record<string, string>
                    )[r.relation]
                  }
                </small>
              </button>
            ))}
            <div className="relation-form">
              <select
                aria-label="Связь"
                value={relation}
                onChange={(e) => setRelation(e.target.value)}
              >
                <option value="associated">Связана с</option>
                <option value="hosts">Принимает событие</option>
                <option value="organizes">Организует</option>
                <option value="recommends">Рекомендует</option>
              </select>
              <select
                aria-label="Связанная запись"
                value={related}
                onChange={(e) => setRelated(e.target.value)}
              >
                <option value="">Выберите запись</option>
                {entities
                  .filter((e) => e.id !== id && e.demo === entity.demo)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
              </select>
              <Button
                disabled={busy || !related}
                onClick={() =>
                  action("/entities/" + id + "/relations", "POST", {
                    toId: related,
                    relation,
                  })
                }
              >
                <Plus size={15} />
              </Button>
            </div>
          </section>
          <section className="detail-section">
            <h3>
              Происхождение <small>{entity.provenance.length}</small>
            </h3>
            {entity.provenance.map((p) => (
              <details className="provenance" key={p.id}>
                <summary>
                  <span>{p.sourceName}</span>
                  <small>{new Date(p.fetchedAt).toLocaleString("ru-RU")}</small>
                </summary>
                <div>
                  <External href={p.sourceUrl}>Оригинальная запись</External>
                  <p>
                    <small>ID: {p.externalId}</small>
                  </p>
                  <pre>{JSON.stringify(p.rawPayload, null, 2)}</pre>
                  <small className="checksum">SHA-256: {p.checksum}</small>
                </div>
              </details>
            ))}
          </section>
          <details className="detail-section">
            <summary>AI metadata и ручное объединение</summary>
            <div className="ai-info">
              <span>Решение: {entity.aiDecision}</span>
              <span>Оценка: {entity.aiScore ?? "—"}</span>
              <p>{entity.aiReason || "Внешняя оценка ещё не добавлена."}</p>
            </div>
            <label className="field">
              <span>Объединить другую запись с этой</span>
              <select value={merge} onChange={(e) => setMerge(e.target.value)}>
                <option value="">Выберите дубликат</option>
                {entities
                  .filter(
                    (e) =>
                      e.id !== id &&
                      e.type === entity.type &&
                      e.demo === entity.demo &&
                      e.country === entity.country,
                  )
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
              </select>
            </label>
          </details>
          {merge && (
            <div className="merge-confirm">
              <strong>
                Объединить «{entities.find((e) => e.id === merge)?.title}» с
                этой записью?
              </strong>
              <p>
                Сохранятся поля этой карточки, заметки и все первоисточники.
                Вторая запись будет удалена.
              </p>
              <div className="actions">
                <Button onClick={() => setMerge("")}>Отмена</Button>
                <Button
                  primary
                  disabled={busy}
                  onClick={async () => {
                    await action("/entities/" + id + "/merge", "POST", {
                      removeId: merge,
                    });
                    setMerge("");
                  }}
                >
                  <Check size={14} />
                  Объединить
                </Button>
              </div>
            </div>
          )}
          <footer className="detail-footer">
            Добавлено {displayDate(entity.createdAt, { year: "numeric" })} ·
            Обновлено {displayDate(entity.updatedAt, { year: "numeric" })}
          </footer>
        </>
      ) : (
        !error && (
          <div className="loading">
            <Busy />
            Загрузка…
          </div>
        )
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

import "./google-saved.css";
import { useEffect, useState } from "react";

type Status = {
  items: number;
  collections: { collection: string; items: number }[];
  available: boolean;
  imports: {
    id: string;
    importedAt: string;
    itemCount: number;
    collectionCount: number;
  }[];
};
async function api(path: string, body?: unknown) {
  const response = await fetch(
    "/api/google-saved/" + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Ошибка Google saved lists");
  return value;
}
export function GoogleSavedLists() {
  const [status, setStatus] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const refresh = async () => setStatus(await api("status"));
  useEffect(() => {
    refresh().catch((e) => setMessage(String(e.message)));
  }, []);
  const action = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await call();
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Операция не завершена");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="google-saved-lists">
      <h2>Списки Google · Takeout</h2>
      <p>
        Знакомые места из ваших списков исключаются из поиска новых мест. Импорт
        объединяет списки; карточки Activity Checker автоматически не создаются.
      </p>
      <p>
        Обновляйте индекс новой выгрузкой Google Takeout. Он объединяет
        импортированные списки и сохраняет ранее знакомые места.
      </p>
      <p>
        <a href="https://takeout.google.com/" target="_blank" rel="noreferrer">
          Открыть Google Takeout
        </a>
      </p>
      {status && (
        <>
          <p>
            В индексе: {status.items} записей, {status.collections.length}{" "}
            списков.
          </p>
          <ul>
            {status.collections.map((c) => (
              <li key={c.collection}>
                {c.collection}: {c.items}
              </li>
            ))}
          </ul>
          <button disabled={busy} onClick={() => action(refresh)}>
            Обновить статус
          </button>
          {status.imports.slice(0, 3).map((i) => (
            <p key={i.id}>
              Импорт {new Date(i.importedAt).toLocaleString("ru-RU")}:{" "}
              {i.itemCount} записей, {i.collectionCount} списков
            </p>
          ))}
        </>
      )}
      <details>
        <summary>Как получить выгрузку Google Takeout</summary>
        <p>
          В Takeout нажмите «Отменить выбор», отметьте только «Сохранённое»
          (Saved), выберите ZIP и однократный экспорт. Для Starred Places можно
          добавить «Карты (ваши места)». Импортируйте только нужные списки.
          Архив обрабатывается в памяти; в базе остаются названия, ссылки,
          заметки, теги и доступные идентификаторы.
        </p>
      </details>
      <label>
        Импорт ZIP / CSV / Maps JSON (до 50 МБ):{" "}
        <input
          type="file"
          accept=".zip,.csv,.json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            action(async () => {
              if (file.size > 50 * 1024 * 1024)
                throw new Error(
                  "Лимит — 50 МБ. Выберите отдельный CSV или ZIP только с сохранёнными списками.",
                );
              const data = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result).split(",")[1]);
                r.onerror = () => reject(new Error("Файл не прочитан"));
                r.readAsDataURL(file);
              });
              await api("import", { filename: file.name, base64: data });
            });
            e.target.value = "";
          }}
        />
      </label>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}

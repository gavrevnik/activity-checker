import { useEffect, useState } from "react";
type Link = {
  localType: string;
  localId: string;
  radarType: string;
  radarId: string;
  canonical: { name?: string; status?: { interest?: string } };
  pending: Array<{ field: string; value: unknown; status: string }>;
};
type Catalog = {
  status: string;
  snapshot?: { synced_at?: string };
  outbox: Record<string, number>;
  links: Link[];
};
export function CatalogPanel() {
  const [data, setData] = useState<Catalog | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const load = async () => {
    const r = await fetch("/api/catalog");
    if (!r.ok) throw new Error("Не удалось прочитать каталог");
    setData(await r.json());
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const change = async (link: Link, interest: string) => {
    setBusy(link.radarId);
    setError("");
    try {
      const r = await fetch(
        `/api/catalog/${encodeURIComponent(link.localType)}/${encodeURIComponent(link.localId)}/interest`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interest: interest || null }),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Не удалось сохранить интерес");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const links =
    data?.links.filter(
      (l, i, all) =>
        ["owner", "source"].includes(l.radarType) &&
        all.findIndex((x) => x.radarId === l.radarId) === i,
    ) || [];
  return (
    <details className="panel" style={{ padding: 12, marginBottom: 16 }}>
      <summary>Каталог Personal Radar</summary>
      <p>
        {data?.snapshot?.synced_at
          ? `Обновлён ${new Date(data.snapshot.synced_at).toLocaleString("ru-RU")}`
          : "Каталог ещё не синхронизирован"}
        . Ожидают отправки: {data?.outbox.pending || 0}; конфликты:{" "}
        {data?.outbox.conflict || 0}.
      </p>
      <p>Общий интерес к источнику. Настройки мониторинга задаются отдельно.</p>
      {error && <p role="alert">{error}</p>}
      <div style={{ maxHeight: 300, overflow: "auto" }}>
        {links.map((l) => {
          const pending = l.pending.find((p) => p.field === "interest");
          const value = pending
            ? typeof pending.value === "string"
              ? pending.value
              : ""
            : l.canonical.status?.interest || "";
          return (
            <label
              key={l.radarId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 8,
              }}
            >
              {l.canonical.name || l.radarId}
              <select
                aria-label={`Интерес: ${l.canonical.name || l.radarId}`}
                value={value}
                disabled={busy === l.radarId || pending?.status === "conflict"}
                onChange={(e) => change(l, e.target.value)}
              >
                <option value="">Не оценено</option>
                <option value="low">Низкий</option>
                <option value="medium">Средний</option>
                <option value="high">Высокий</option>
              </select>
            </label>
          );
        })}
      </div>
    </details>
  );
}

import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { api } from "./api";
import type { AutoArchiveSettings } from "../shared/auto-archive";
import "./auto-archive.css";

export function AutoArchiveSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    api<AutoArchiveSettings>("/auto-archive/settings")
      .then((settings) => {
        if (!cancelled) setEnabled(settings.enabled);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save(next: boolean) {
    setSaving(true);
    setError("");
    try {
      const settings = await api<AutoArchiveSettings>(
        "/auto-archive/settings",
        "PUT",
        { enabled: next },
      );
      setEnabled(settings.enabled);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="auto-archive-setting" aria-busy={saving || undefined}>
      <Archive size={15} aria-hidden="true" />
      <label>
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === null || saving}
          onChange={(event) => void save(event.target.checked)}
        />
        Автоматически архивировать прошедшие мероприятия
      </label>
      <small>При старте сервиса и запуске агрегаторов</small>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

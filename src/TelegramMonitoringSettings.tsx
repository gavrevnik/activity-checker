import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, Busy, Modal } from "./components";
import type { TelegramMonitoringSettingsView } from "../shared/telegram-monitoring";

export function TelegramMonitoringSettings({
  onClose,
}: {
  onClose: () => void;
}) {
  const [view, setView] = useState<TelegramMonitoringSettingsView | null>(null);
  const [keywords, setKeywords] = useState("");
  const [channelSearch, setChannelSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<TelegramMonitoringSettingsView>("/telegram-monitoring/settings")
      .then((value) => {
        if (!cancelled) {
          setView(value);
          setKeywords(value.settings.excludeKeywords.join("\n"));
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function save() {
    if (!view) return;
    setSaving(true);
    setError("");
    try {
      await api("/telegram-monitoring/settings", "PUT", {
        ...view.settings,
        excludeKeywords: keywords
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="Настройки постов"
      onClose={() => {
        if (!saving) onClose();
      }}
      wide
    >
      <div className="telegram-monitoring-settings">
        <p>
          Применяются при следующем мониторинге, до передачи постов в LLM.
          События исключённых каналов также скрываются из ленты. Сохранённые
          события не удаляются.
        </p>
        {error && (
          <p role="alert" className="telegram-events-error">
            {error}
          </p>
        )}
        {!view && !error && (
          <p>
            <Busy /> Загружаю настройки…
          </p>
        )}
        {view && (
          <>
            <label className="telegram-keywords">
              Теги / ключевые слова для исключения
              <textarea
                rows={5}
                value={keywords}
                disabled={saving}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder="Один ключевик на строку"
              />
            </label>
            <small>
              Любое совпадение убирает весь пост. Поиск по тексту, включая
              #теги: без учёта регистра, буквальное вхождение, не регулярное
              выражение.
            </small>
            <label>
              <input type="checkbox" checked disabled /> Исключать ответы /
              комментарии
            </label>
            <label>
              <input type="checkbox" checked disabled /> Исключать явную рекламу
              (#реклама, #ad, erid)
            </label>
            <label>
              Минимум символов текста
              <input
                type="number"
                min={51}
                max={20000}
                value={view.settings.minTextLength}
                disabled={saving}
                onChange={(event) =>
                  setView({
                    ...view,
                    settings: {
                      ...view.settings,
                      minTextLength: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <small>
              Общие правила всех Telegram API: ответы и реклама исключены, текст
              длиннее 50 символов. Минимальную длину можно увеличить.
            </small>
            <h3>Не мониторить каналы</h3>
            <p>
              Отмеченные каналы пропускаются полностью: запросов к Telegram по
              ним не будет.
            </p>
            <input
              aria-label="Поиск каналов в настройках"
              placeholder="Название или @username"
              value={channelSearch}
              onChange={(event) => setChannelSearch(event.target.value)}
            />
            <div className="telegram-settings-channels">
              {view.channels
                .filter((channel) =>
                  `${channel.title} ${channel.username}`
                    .toLowerCase()
                    .includes(channelSearch.toLowerCase()),
                )
                .map((channel) => {
                  const username = channel.username.toLowerCase();
                  return (
                    <label key={channel.communityId}>
                      <input
                        type="checkbox"
                        disabled={saving}
                        checked={view.settings.excludedChannels.includes(
                          username,
                        )}
                        onChange={(event) =>
                          setView({
                            ...view,
                            settings: {
                              ...view.settings,
                              excludedChannels: event.target.checked
                                ? [...view.settings.excludedChannels, username]
                                : view.settings.excludedChannels.filter(
                                    (item) => item !== username,
                                  ),
                            },
                          })
                        }
                      />
                      <span>
                        {channel.title}
                        <small>@{channel.username}</small>
                      </span>
                    </label>
                  );
                })}
              {view.settings.excludedChannels
                .filter(
                  (username) =>
                    !view.channels.some(
                      (channel) => channel.username.toLowerCase() === username,
                    ),
                )
                .map((username) => (
                  <label key={username}>
                    <input
                      type="checkbox"
                      checked
                      disabled={saving}
                      onChange={() =>
                        setView({
                          ...view,
                          settings: {
                            ...view.settings,
                            excludedChannels:
                              view.settings.excludedChannels.filter(
                                (item) => item !== username,
                              ),
                          },
                        })
                      }
                    />
                    <span>
                      @{username}
                      <small>Канал отсутствует в активном списке</small>
                    </span>
                  </label>
                ))}
            </div>
            <div className="telegram-event-actions">
              <Button primary disabled={saving} onClick={() => void save()}>
                {saving ? "Сохраняю…" : "Сохранить"}
              </Button>
              <Button disabled={saving} onClick={onClose}>
                Отмена
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

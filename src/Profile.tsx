import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CalendarHeart,
  Music2,
  RotateCcw,
  Save,
  Sparkles,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  defaultFilteringRules,
  type FilteringRules,
  type UserProfile,
  type UserProfileInput,
} from "../shared/model";
import {
  profileFilterDescriptions,
  disableSampleFilters,
} from "../shared/profile-filters";
import { Busy, Button } from "./components";

interface Draft {
  summary: string;
  eventPreferences: string;
  communityPreferences: string;
  musicPreferences: string;
  artists: string;
  additionalPreferences: string;
  automaticFilters: FilteringRules;
  excludedTelegramChannels: string;
}

const listText = (items: string[]) =>
  items.map((item) => `• ${item}`).join("\n");
const parseList = (value: string) =>
  value
    .split("\n")
    .map((item) => item.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
const toDraft = (profile: UserProfile): Draft => ({
  summary: profile.summary,
  eventPreferences: listText(profile.eventPreferences),
  communityPreferences: listText(profile.communityPreferences),
  musicPreferences: listText(profile.musicPreferences),
  artists: profile.artists.join("\n"),
  additionalPreferences: profile.additionalPreferences || "",
  automaticFilters: profile.automaticFilters || defaultFilteringRules,
  excludedTelegramChannels: (profile.excludedTelegramChannels || []).join("\n"),
});
const toInput = (draft: Draft): UserProfileInput => ({
  summary: draft.summary.trim(),
  eventPreferences: parseList(draft.eventPreferences),
  communityPreferences: parseList(draft.communityPreferences),
  musicPreferences: parseList(draft.musicPreferences),
  artists: parseList(draft.artists),
  additionalPreferences: draft.additionalPreferences.trim(),
  automaticFilters: draft.automaticFilters,
  excludedTelegramChannels: parseList(draft.excludedTelegramChannels).map(
    (item) => item.replace(/^@/, ""),
  ),
});

function ProfileField({
  label,
  value,
  onChange,
  hint,
  rows = 7,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
  rows?: number;
  placeholder?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [value]);
  return (
    <label className="profile-field">
      <span>{label}</span>
      <textarea
        ref={textarea}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{hint}</small>
    </label>
  );
}

export function Profile({
  profile,
  busy,
  onSave,
  embedded = false,
}: {
  embedded?: boolean;
  profile: UserProfile;
  busy: boolean;
  onSave: (profile: UserProfileInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [artistsOpen, setArtistsOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => setDraft(toDraft(profile)), [profile]);
  const input = useMemo(() => toInput(draft), [draft]);
  const original = useMemo(() => {
    return toInput(toDraft(profile));
  }, [profile]);
  const changed = JSON.stringify(input) !== JSON.stringify(original);
  const set = (key: keyof Draft) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const updatedAt = new Date(profile.updatedAt).toLocaleString("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Belgrade",
  });

  return (
    <form
      className="profile-page"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) {
          setSaveError("");
          void onSave(input).catch((error) =>
            setSaveError((error as Error).message),
          );
        }
      }}
    >
      <div className="page-heading profile-heading">
        <div>
          <div className="heading-title">
            <UserRound size={24} />
            {embedded ? <h2>Личные предпочтения</h2> : <h1>Мой профиль</h1>}
          </div>
          <p>
            Ваши интересы, языки и музыкальные предпочтения. Модель учитывает их
            при следующем обновлении рекомендаций.
          </p>
        </div>
        <div className="actions">
          <Button
            onClick={() => setDraft(toDraft(profile))}
            disabled={!changed || busy}
          >
            <RotateCcw size={14} />
            Отменить изменения
          </Button>
          <Button type="submit" primary disabled={!changed || busy}>
            {busy ? <Busy /> : <Save size={14} />}
            Сохранить профиль
          </Button>
        </div>
      </div>

      {saveError && (
        <p className="error-text" role="alert">
          {saveError}
        </p>
      )}
      <section className="profile-intro">
        <Sparkles size={18} />
        <div>
          <strong>Как использовать этот профиль</strong>
          <p>
            В списках — один интерес на строку. После сохранения попросите
            модель обновить рекомендации, чтобы применить изменения.
          </p>
        </div>
      </section>

      <div className="profile-grid">
        <section className="profile-card">
          <header>
            <UserRound size={18} />
            <div>
              <h2>Общая информация</h2>
              <p>Локация, языки, профессиональный контекст и цели общения.</p>
            </div>
          </header>
          <ProfileField
            label="Обо мне и целях поиска"
            value={draft.summary}
            onChange={set("summary")}
            rows={8}
            hint="Свободный текст; до 5 000 символов."
            placeholder="Локация, интересы и цели…"
          />
        </section>

        <section className="profile-card">
          <header>
            <CalendarHeart size={18} />
            <div>
              <h2>Предпочтительные события</h2>
              <p>Темы, масштабы и форматы, которые стоит находить чаще.</p>
            </div>
          </header>
          <ProfileField
            label="Приоритеты"
            value={draft.eventPreferences}
            onChange={set("eventPreferences")}
            hint="Один приоритет на строку."
          />
        </section>

        <section className="profile-card">
          <header>
            <UsersRound size={18} />
            <div>
              <h2>Предпочтительные сообщества</h2>
              <p>Тематика, язык, география и желаемый формат общения.</p>
            </div>
          </header>
          <ProfileField
            label="Какие сообщества искать"
            value={draft.communityPreferences}
            onChange={set("communityPreferences")}
            hint="Один тип сообщества на строку."
          />
        </section>

        <section className="profile-card">
          <header>
            <Music2 size={18} />
            <div>
              <h2>Музыкальные интересы</h2>
              <p>Жанры, настроение и типы музыкальных событий.</p>
            </div>
          </header>
          <ProfileField
            label="Музыкальные предпочтения"
            value={draft.musicPreferences}
            onChange={set("musicPreferences")}
            hint="Жанры, настроение и предпочтения для концертных рекомендаций."
            rows={6}
          />
          <details
            className="profile-artists"
            onToggle={(event) => setArtistsOpen(event.currentTarget.open)}
          >
            <summary>
              <span>Любимые артисты</span>
              <span className="badge">{input.artists.length}</span>
            </summary>
            <div>
              <p>
                Добавьте любимых исполнителей — модель учтёт их при подборе
                концертов.
              </p>
              <ProfileField
                key={artistsOpen ? "artists-open" : "artists-closed"}
                label="Любимые артисты"
                value={draft.artists}
                onChange={set("artists")}
                hint="Один артист на строку; список по умолчанию свёрнут."
                rows={14}
              />
            </div>
          </details>
        </section>
        <section className="profile-card">
          <header>
            <div>
              <h2>Дополнительно</h2>
              <p>
                Языки, исключения, правила включения и автоматические фильтры.
              </p>
            </div>
          </header>
          <ProfileField
            label="Дополнительные условия рекомендаций"
            value={draft.additionalPreferences}
            onChange={set("additionalPreferences")}
            rows={10}
            hint="Это ваши условия. Можно изменить или удалить любые предпочтения образца, включая приоритет русского языка."
          />
          <div className="profile-filter-options">
            <h3>Автоматические фильтры</h3>
            <p className="muted">
              Включённые условия исключают карточки до оценки моделью.
              Отключение снимает ограничение; исходные данные сохраняются.
            </p>
            {profileFilterDescriptions(draft.automaticFilters).map(
              ({ code, text }) => (
                <label key={code}>
                  <input
                    type="checkbox"
                    checked={draft.automaticFilters[code].enabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        automaticFilters: {
                          ...current.automaticFilters,
                          [code]: {
                            ...current.automaticFilters[code],
                            enabled: event.target.checked,
                          },
                        },
                      }))
                    }
                  />
                  <span>{text}</span>
                </label>
              ),
            )}
            <Button
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  automaticFilters: disableSampleFilters(
                    current.automaticFilters,
                  ),
                  excludedTelegramChannels: "",
                }))
              }
            >
              Отключить фильтры образца и исключения каналов
            </Button>
          </div>
          <ProfileField
            label="Не читать эти Telegram-каналы"
            value={draft.excludedTelegramChannels}
            onChange={set("excludedTelegramChannels")}
            rows={3}
            hint="Один username на строку. Пустой список разрешает все включённые источники выбранного города; это не подписка и не вступление в группы."
          />
        </section>
      </div>

      <p className="profile-updated">
        Последнее сохранение: {updatedAt} · сохранено на этом компьютере
      </p>
    </form>
  );
}

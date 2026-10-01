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
import type { UserProfile, UserProfileInput } from "../shared/model";
import { Busy, Button } from "./components";

interface Draft {
  summary: string;
  eventPreferences: string;
  communityPreferences: string;
  musicPreferences: string;
  artists: string;
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
});
const toInput = (draft: Draft): UserProfileInput => ({
  summary: draft.summary.trim(),
  eventPreferences: parseList(draft.eventPreferences),
  communityPreferences: parseList(draft.communityPreferences),
  musicPreferences: parseList(draft.musicPreferences),
  artists: parseList(draft.artists),
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
}: {
  profile: UserProfile;
  busy: boolean;
  onSave: (profile: UserProfileInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [artistsOpen, setArtistsOpen] = useState(false);
  useEffect(() => setDraft(toDraft(profile)), [profile]);
  const input = useMemo(() => toInput(draft), [draft]);
  const original = useMemo(() => {
    const { updatedAt: _updatedAt, ...value } = profile;
    return value;
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
        if (changed && !busy) void onSave(input);
      }}
    >
      <div className="page-heading profile-heading">
        <div>
          <div className="heading-title">
            <UserRound size={24} />
            <h1>Мой профиль</h1>
          </div>
          <p>
            Общий контекст и предпочтения для поиска событий и сообществ. Позже
            их можно будет передавать LLM для ранжирования найденного.
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

      <section className="profile-intro">
        <Sparkles size={18} />
        <div>
          <strong>Как использовать этот профиль</strong>
          <p>
            Все четыре блока раскрываются по объёму текста. В списках — один
            приоритет на строку; маркеры можно добавлять или не добавлять.
            Сейчас профиль хранится только локально и ещё не запускает
            автоматическую AI-фильтрацию.
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
            hint="Стартовое заполнение составлено по артистам из content-checker."
            rows={6}
          />
          <details
            className="profile-artists"
            onToggle={(event) => setArtistsOpen(event.currentTarget.open)}
          >
            <summary>
              <span>Артисты из content-checker</span>
              <span className="badge">{input.artists.length}</span>
            </summary>
            <div>
              <p>
                Исходный список скопирован из музыкального seed соседнего
                проекта. Здесь его можно независимо дополнить или сократить.
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
      </div>

      <p className="profile-updated">
        Последнее сохранение: {updatedAt} · локальная SQLite
      </p>
    </form>
  );
}

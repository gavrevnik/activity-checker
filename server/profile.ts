import type { UserProfileInput } from "../shared/model.js";

export const cinemaClubPreference =
  "Киноклубы и регулярные кинопоказы с обсуждением: авторское, фестивальное и международное кино.";

// Snapshot of content-checker/data/music_seed_artists.json. It is copied here
// deliberately so Activity Checker keeps working when the sibling app is absent.
export const defaultUserProfile: UserProfileInput = {
  summary:
    "Локация и языки\n• Живу в Белграде; основной фокус — локальные события, активности, сообщества и места.\n• Русский — основной язык, английский тоже подходит; комфортны русскоязычная и международная среда.\n\nПрофессиональный контекст\n• Интересуюсь product analytics, data/statistics, Python/SQL, AI/LLM, coding agents, AI-продуктами, product management, startups и близкими технологическими темами.\n• Хочу обмениваться опытом и расширять профессиональную сеть, в том числе формировать контакты, которые могут быть полезны при будущем поиске работы.\n\nСоциальные цели\n• Хочу расширять круг общения, находить новые постоянные компании, друзей и знакомых через естественное регулярное взаимодействие.\n• Интересны форматы, где можно органично знакомиться с девушками и потенциально встретить партнёра для отношений; это не обязательно специализированные dating-events.\n\nПринципы рекомендаций\n• Выше оценивать небольшие группы, активное участие, живое общение и повторные встречи; ниже — полностью пассивные и анонимные форматы.\n• Не ограничиваться крупными официальными мероприятиями: учитывать локальные клубы, Telegram/Instagram-группы и нишевые встречи.\n• Сочетать устойчивые интересы с exploration и периодически предлагать новые подходящие социальные, спортивные и профессиональные форматы.",
  eventPreferences: [
    "IT/AI/data/product-события: конференции, talks, workshops, startup/founder events, митапы и открытые мероприятия технологических компаний.",
    "Community meetups, expat/international events, language exchange, social mixers, тематические клубы, квизы и игровые встречи.",
    "Сквош и падел имеют одинаково высокий приоритет: игры, тренировки, турниры, клубные встречи и поиск партнёров по игре.",
    "Другие групповые спортивные и social/networking-oriented активности с низким порогом входа и возможностью регулярного общения.",
    "Beginner-friendly salsa, bachata и другие social dances — умеренный приоритет, преимущественно благодаря социальной составляющей.",
    "Новые beginner-friendly занятия, куда можно прийти без своей компании и предварительной серьёзной подготовки.",
    "Туризм, хайкинг, отдых на природе, поездки по Сербии и открытие интересных мест в Белграде и окрестностях.",
    "Фуд-туризм, wine и beer tastings, гастрономические мероприятия, необычная еда, локальная кухня и тематические food-events.",
    cinemaClubPreference,
    "Интерактивные культурные форматы: кинопоказы с обсуждением, арт-программы, лекции и необычные городские активности.",
  ],
  communityPreferences: [
    "Русскоязычные сообщества Белграда и Сербии, а также открытые международные группы с регулярными офлайн-встречами.",
    "Профессиональные IT/AI/data/product/engineering- и startup-сообщества для обмена опытом, карьерными практиками и контактами.",
    "Сообщества создателей AI-продуктов, coding agents, автоматизаций, pet-проектов и локальных сервисов.",
    "Клубы и группы по сквошу, паделу и другим социальным видам спорта, включая поиск постоянных партнёров по игре.",
    "Туристические, hiking- и outdoor-сообщества для совместных поездок, прогулок, походов, отдыха на природе и исследования интересных мест.",
    "Гастрономические сообщества и клубы, которые вместе исследуют локальную кухню, необычные заведения и food-направления.",
    "Expat-, language-exchange- и social-сообщества, тематические клубы и группы, где участники действительно знакомятся и общаются.",
    "Музыкальные, киноклубные, гастрономические и культурные сообщества с близкими интересами.",
    "Небольшие локальные Telegram/Instagram-группы, нишевые клубы и регулярные встречи, даже если у них нет крупной официальной афиши.",
    "Приоритет устойчивым сообществам и повторным встречам, где со временем можно сформировать постоянный круг общения.",
  ],
  musicPreferences: [
    "Alternative, indie и art rock; атмосферный pop/rock, dream pop и dark pop.",
    "Industrial, gothic и alternative metal; symphonic metal и post-hardcore.",
    "Trip-hop, downtempo, dark electronic, electronic pop, experimental pop и кинематографичная музыка.",
    "Nordic folk, dark folk и ритуальная folk-сцена.",
    "Предпочтение выразительным, меланхоличным, тёмным и атмосферным лайвам.",
    "Балканская музыка обычно неинтересна: события, где она является основной составляющей, понижать в рейтинге.",
  ],
  artists: [
    "HÆLOS",
    "Marilyn Manson",
    "Arctic Monkeys",
    "Nightwish",
    "Hurts",
    "AWOLNATION",
    "London Grammar",
    "alt-J",
    "Lorde",
    "The xx",
    "Thirty Seconds to Mars",
    "OneRepublic",
    "AURORA",
    "Radiohead",
    "Serj Tankian",
    "SVRCINA",
    "Iron Maiden",
    "Metallica",
    "Florence + The Machine",
    "Poets of the Fall",
    "Kalandra",
    "Bring Me the Horizon",
    "Lana Del Rey",
    "Stone Sour",
    "Rammstein",
    "Evanescence",
    "Linkin Park",
    "James Blake",
    "Massive Attack",
    "Portishead",
    "Archive",
    "Woodkid",
    "Sevdaliza",
    "Son Lux",
    "Muse",
    "Tame Impala",
    "CHVRCHES",
    "System of a Down",
    "Slipknot",
    "Deftones",
    "Within Temptation",
    "Ghost",
    "Eivør",
    "Wardruna",
    "Heilung",
    "Chelsea Wolfe",
  ],
};

export function upgradeUserProfileDefaults(
  profile: UserProfileInput,
): UserProfileInput {
  if (
    profile.eventPreferences.some((preference) =>
      preference.toLocaleLowerCase("ru").includes("киноклуб"),
    )
  )
    return profile;
  return {
    ...profile,
    eventPreferences: [...profile.eventPreferences, cinemaClubPreference],
  };
}

export function upgradeLegacyUserProfile(
  value: unknown,
): UserProfileInput | null {
  if (!value || typeof value !== "object") return null;
  const legacy = value as Record<string, unknown>;
  if (!("networkingGoals" in legacy) && !("searchNotes" in legacy)) return null;
  const artists = Array.isArray(legacy.artists)
    ? legacy.artists.filter(
        (artist): artist is string =>
          typeof artist === "string" && !!artist.trim(),
      )
    : [];
  return {
    ...defaultUserProfile,
    artists: artists.length ? artists : defaultUserProfile.artists,
  };
}

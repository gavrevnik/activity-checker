import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "dotenv";
import { Store } from "../server/store.js";
import { prepareRecommendationTelegramSources } from "../server/recommendation-setup.js";
import { parseArgs } from "node:util";
import { userProfileSchema } from "../shared/model.js";

const { values: options } = parseArgs({
  options: {
    init: { type: "boolean" },
    "import-keys": { type: "string" },
    "prepare-sources": { type: "boolean" },
    scope: { type: "string", default: "belgrade" },
  },
});
if (!options.init && !options["import-keys"] && !options["prepare-sources"])
  throw Error(
    "Используйте --init, --import-keys <файл> или --prepare-sources --scope <город>.",
  );
const envPath = resolve(".env.local");
const isRegular = (path: string) => {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
    throw Error("Ожидался обычный локальный файл.");
};
let content = "";
if (existsSync(envPath)) {
  isRegular(envPath);
  content = readFileSync(envPath, "utf8");
}
const importing = options["import-keys"];
if (importing) {
  const path = importing;
  if (!path || path.startsWith("--")) throw Error("Укажите файл с ключами.");
  isRegular(path);
  chmodSync(path, 0o600);
  const values = parse(readFileSync(path));
  const allowed = new Set([
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_PYTHON",
    "TELEGRAM_SESSION_PATH",
    "APIFY_TOKEN",
    "TICKETMASTER_API_KEY",
    "FOURSQUARE_API_KEY",
    "GOOGLE_PLACES_API_KEY",
  ]);
  if (
    !Object.keys(values).length ||
    Object.keys(values).some((key) => !allowed.has(key))
  )
    throw Error(
      "Файл должен содержать только известные переменные подключения из .env.example.",
    );
  if (Object.values(values).some((value) => /[\r\n\0]/.test(value)))
    throw Error("Значение ключа должно занимать одну строку.");
  // Parse data only: never source/eval a file containing credentials.
  content = content
    .split("\n")
    .filter((line) => {
      const key = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=/)?.[1];
      return !key || !(key in values);
    })
    .join("\n");
  for (const [key, value] of Object.entries(values)) {
    if (value.includes('"'))
      throw Error("Значение ключа не должно содержать двойную кавычку.");
    content += `\n${key}="${value}"`;
  }
}
if (!existsSync(envPath) || Boolean(importing)) {
  writeFileSync(envPath, content.trim() + "\n", { mode: 0o600 });
  chmodSync(envPath, 0o600);
}
if (Boolean(importing))
  console.log(
    "Ключи перенесены в .env.local; значения не выводятся. Временный файл можно удалить.",
  );
if (options.init) {
  mkdirSync(resolve(".runtime"), { recursive: true });
  writeFileSync(resolve(".runtime/node-bin"), process.execPath + "\n", {
    mode: 0o600,
  });
  const env = parse(content);
  const path = resolve(
    process.env.ACTIVITY_DB ||
      env.ACTIVITY_DB ||
      "../data/activity-checker/activity.sqlite",
  );
  if (existsSync(path))
    console.log(
      "База уже существует: сохранена без изменений. Проверка: npm run start:check.",
    );
  else {
    const profile = userProfileSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("../examples/recommendation-profile.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    // Reserve the new file exclusively; never reset or copy the owner's database.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    const store = new Store(path);
    try {
      store.saveProfile(profile);
      store.db
        .prepare(
          "INSERT OR IGNORE INTO settings(key,value) VALUES ('demo-initialized','1')",
        )
        .run();
    } finally {
      store.close();
    }
    console.log(
      "Новая база и каталог готовы. Профиль-образец установлен; настройте его под себя в «Мой профиль».",
    );
  }
}

if (options["prepare-sources"]) {
  const env = parse(content);
  const path = resolve(
    process.env.ACTIVITY_DB ||
      env.ACTIVITY_DB ||
      "../data/activity-checker/activity.sqlite",
  );
  const store = Store.openExisting(path);
  try {
    console.log(
      JSON.stringify(
        prepareRecommendationTelegramSources(store, options.scope!),
      ),
    );
  } finally {
    store.close();
  }
}

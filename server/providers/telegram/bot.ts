import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createTelegramBotClient,
  TelegramBotError,
} from "@personal-radar/connectors/telegram/bot";
import { readSecrets } from "../../secrets.js";

export const botSendSchema = z
  .object({
    requestId: z.uuid(),
    text: z
      .string()
      .min(1)
      .max(4000)
      .refine((v) => !!v.trim()),
    confirmed: z.literal(true),
  })
  .strict();
type Receipt = {
  requestId: string;
  fingerprint: string;
  status: "unknown" | "sent" | "rejected";
  updatedAt: string;
  messageId?: number;
  errorCode?: number;
  retryAfterSeconds?: number;
};
type Dependencies = {
  root?: string;
  secrets?: typeof readSecrets;
  readKeychain?: (service: string, account: string) => Promise<string>;
  client?: typeof createTelegramBotClient;
};

async function readKeychain(service: string, account: string) {
  if (process.platform !== "darwin")
    throw new Error("macOS Keychain недоступен на этой платформе.");
  try {
    const { stdout } = await promisify(execFile)(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: 15_000, maxBuffer: 16_384 },
    );
    return stdout.trim();
  } catch {
    throw new Error(
      "Токен бота недоступен в macOS Keychain этому процессу. Проверьте доступ в обычном Terminal; токен в чат не отправляйте.",
    );
  }
}

export function createOwnerBotService(deps: Dependencies = {}) {
  const root = resolve(deps.root ?? process.cwd());
  function config() {
    const s = (deps.secrets ?? readSecrets)();
    return {
      token: s.TELEGRAM_BOT_TOKEN,
      service: s.TELEGRAM_BOT_KEYCHAIN_SERVICE,
      account: s.TELEGRAM_BOT_KEYCHAIN_ACCOUNT,
      username: s.TELEGRAM_BOT_USERNAME?.replace(/^@/, ""),
      chatId: s.TELEGRAM_BOT_OWNER_CHAT_ID,
    };
  }
  function status() {
    const c = config();
    return {
      configured: !!(
        c.username &&
        c.chatId &&
        (c.token || (c.service && c.account))
      ),
      botUsername: c.username ?? null,
      ownerChatId: c.chatId ?? null,
      credentialStorage: c.token
        ? "environment"
        : c.service && c.account
          ? "macos-keychain"
          : null,
      verified: false,
      note: "Локальная конфигурация; без чтения токена и запросов к Telegram. Только личный чат владельца, по явной просьбе; входящие сообщения не читаются.",
    };
  }
  async function send(input: unknown) {
    const args = botSendSchema.parse(input);
    const c = config();
    if (!status().configured)
      throw new Error(
        "Настройте Telegram Bot credential, username и личный chat ID.",
      );
    // Validate target configuration before touching credentials or the network.
    if (!/^[1-9]\d{0,15}$/.test(c.chatId!))
      throw new Error("Разрешён только настроенный личный chat ID.");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([c.username!.toLowerCase(), c.chatId, args.text]))
      .digest("hex");
    const directory = join(root, ".runtime", "telegram-bot");
    const path = join(directory, args.requestId + ".json");
    async function existing() {
      let receipt: Receipt;
      try {
        receipt = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(
          "Журнал отправки повреждён или недоступен; повтор заблокирован.",
        );
      }
      if (receipt.fingerprint !== fingerprint)
        throw new Error(
          "requestId уже использован для другого текста или адресата.",
        );
      return { ...receipt, replay: true };
    }
    const previous = await existing();
    if (previous) return previous;
    const token =
      c.token ||
      (await (deps.readKeychain ?? readKeychain)(c.service!, c.account!));
    if (args.text.includes(token))
      throw new Error("Текст содержит токен бота; отправка отменена.");
    const client = (deps.client ?? createTelegramBotClient)({
      token,
      username: c.username!,
      ownerChatId: c.chatId!,
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, "send.lock");
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      throw new Error(
        "Другая отправка выполняется либо остался lock после остановки. Проверьте журнал; не удаляйте lock для слепого повтора.",
      );
    }
    try {
      const replay = await existing();
      if (replay) return replay;
      await client.verify();
      const lastPath = join(directory, "last-send.json");
      let last = 0;
      try {
        last = JSON.parse(await readFile(lastPath, "utf8")).at;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error(
            "Не удалось прочитать ограничитель частоты отправки.",
          );
      }
      if (!Number.isFinite(last))
        throw new Error("Ограничитель частоты повреждён.");
      await delay(Math.max(0, last + 1200 - Date.now()));
      const receipt: Receipt = {
        requestId: args.requestId,
        fingerprint,
        status: "unknown",
        updatedAt: new Date().toISOString(),
      };
      // Persist intent before dispatch. A crash/lost response never causes a resend.
      await writeFile(path, JSON.stringify(receipt), {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(lastPath, JSON.stringify({ at: Date.now() }), {
        mode: 0o600,
      });
      try {
        const result = await client.sendText(args.text);
        receipt.status = "sent";
        receipt.messageId = result.messageId;
      } catch (error) {
        if (error instanceof TelegramBotError && error.outcome === "rejected") {
          receipt.status = "rejected";
          receipt.errorCode = error.code;
          receipt.retryAfterSeconds = error.retryAfterSeconds;
        }
        // Any other exception is an unknown delivery; never include native errors.
      }
      receipt.updatedAt = new Date().toISOString();
      await writeFile(path + ".tmp", JSON.stringify(receipt), { mode: 0o600 });
      await rename(path + ".tmp", path);
      return { ...receipt, replay: false };
    } finally {
      await lock.close();
      await rm(lockPath);
    }
  }
  return { status, send };
}

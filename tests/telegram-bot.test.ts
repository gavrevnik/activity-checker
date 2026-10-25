import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createOwnerBotService } from "../server/providers/telegram/bot";
import { TelegramBotError } from "@personal-radar/connectors/telegram/bot";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = "123456:synthetic_test_bot_token_only";
function secrets() {
  return {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_BOT_USERNAME: "fixture_bot",
    TELEGRAM_BOT_OWNER_CHAT_ID: "12345",
  };
}
it("replays success across restart without credentials/HTTP; conflicts never resend", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-test-"));
  let sent = 0;
  const client = () => ({
    verify: async () => ({ username: "fixture_bot", chatId: "12345" }),
    sendText: async () => {
      sent++;
      return { messageId: 7, chatId: "12345" };
    },
  });
  const args = {
    requestId: randomUUID(),
    confirmed: true,
    text: "https://t.me/example/3",
  };
  try {
    const result = await createOwnerBotService({ root, secrets, client }).send(
      args,
    );
    expect(result).toMatchObject({
      status: "sent",
      messageId: 7,
      replay: false,
    });
    const restarted = createOwnerBotService({
      root,
      secrets: () => ({
        ...secrets(),
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_BOT_KEYCHAIN_SERVICE: "test",
        TELEGRAM_BOT_KEYCHAIN_ACCOUNT: "fixture_bot",
      }),
      readKeychain: async () => {
        throw Error("Must not read on replay");
      },
      client,
    });
    expect(await restarted.send(args)).toMatchObject({
      status: "sent",
      replay: true,
    });
    await expect(
      restarted.send({ ...args, text: "different" }),
    ).rejects.toThrow("requestId");
    expect(sent).toBe(1);
    const journal = await readFile(
      join(root, ".runtime/telegram-bot", args.requestId + ".json"),
      "utf8",
    );
    expect(journal).not.toContain(token);
    expect(journal).not.toContain(args.text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("unknown delivery and explicit rejection persist without a second attempt", async () => {
  for (const error of [
    new Error("private URL " + token),
    new TelegramBotError("rejected", 429, 10),
  ]) {
    const root = await mkdtemp(join(tmpdir(), "bot-test-"));
    let sent = 0;
    const service = createOwnerBotService({
      root,
      secrets,
      client: () => ({
        verify: async () => ({ username: "fixture_bot", chatId: "12345" }),
        sendText: async () => {
          sent++;
          throw error;
        },
      }),
    });
    const args = { requestId: randomUUID(), confirmed: true, text: "message" };
    try {
      const first = await service.send(args);
      expect(first.status).toBe(
        error instanceof TelegramBotError ? "rejected" : "unknown",
      );
      expect(JSON.stringify(first)).not.toContain(token);
      expect(await service.send(args)).toMatchObject({
        status: first.status,
        replay: true,
      });
      expect(sent).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
it("rejects unconfirmed calls, arbitrary destinations, credential text and target mismatch before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-test-"));
  let sent = 0;
  const service = createOwnerBotService({
    root,
    secrets,
    client: () => ({
      verify: async () => {
        throw Error("wrong bot");
      },
      sendText: async () => {
        sent++;
        return { messageId: 1, chatId: "12345" };
      },
    }),
  });
  const args = { requestId: randomUUID(), confirmed: true, text: "hello" };
  try {
    await expect(service.send({ ...args, confirmed: false })).rejects.toThrow();
    await expect(service.send({ ...args, chatId: "999" })).rejects.toThrow();
    await expect(service.send({ ...args, text: token })).rejects.toThrow(
      "токен",
    );
    await expect(service.send(args)).rejects.toThrow("wrong bot");
    expect(sent).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("locks concurrent sends, rejects corrupt receipt and never auto-clears stale lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-test-"));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let sent = 0;
  const service = createOwnerBotService({
    root,
    secrets,
    client: () => ({
      verify: async () => {
        entered();
        await wait;
        return { username: "fixture_bot", chatId: "12345" };
      },
      sendText: async () => {
        sent++;
        return { messageId: 1, chatId: "12345" };
      },
    }),
  });
  const args = { requestId: randomUUID(), confirmed: true, text: "hello" };
  try {
    const first = service.send(args);
    await started;
    await expect(
      service.send({ ...args, requestId: randomUUID() }),
    ).rejects.toThrow("отправка");
    release();
    await first;
    expect(sent).toBe(1);
    await writeFile(
      join(root, ".runtime/telegram-bot", args.requestId + ".json"),
      "corrupt",
    );
    await expect(service.send(args)).rejects.toThrow("Журнал");
    await writeFile(join(root, ".runtime/telegram-bot/send.lock"), "stale");
    await expect(
      service.send({ ...args, requestId: randomUUID() }),
    ).rejects.toThrow("lock");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});
it("MCP advertises send as write/idempotent, fixed recipient and no auto send on status/list", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-mcp-test-"));
  const client = new Client({ name: "bot-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/telegram-monitoring-mcp.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      ACTIVITY_DB: join(root, "unused.sqlite"),
      TELEGRAM_BOT_USERNAME: "fixture_bot",
      TELEGRAM_BOT_OWNER_CHAT_ID: "12345",
      TELEGRAM_BOT_TOKEN: token,
    },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const send = tools.tools.find(
      (t) => t.name === "telegram_send_message_to_owner",
    )!;
    expect(send.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(send.inputSchema.properties).not.toHaveProperty("chatId");
    expect(send.inputSchema.properties).not.toHaveProperty("token");
    const status = await client.callTool({
      name: "telegram_bot_status",
      arguments: {},
    });
    expect(status.structuredContent).toMatchObject({
      configured: true,
      verified: false,
      ownerChatId: "12345",
    });
    expect(JSON.stringify(status)).not.toContain(token);
    const rejected = await client.callTool({
      name: "telegram_send_message_to_owner",
      arguments: { requestId: randomUUID(), text: "test", confirmed: false },
    });
    expect(rejected.isError).toBe(true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

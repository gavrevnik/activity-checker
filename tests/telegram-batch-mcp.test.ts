import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store";

it("runs 50-channel MCP through the real facade/stdio adapter with a synthetic Python worker, then reads the durable result after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-mcp-fixture-")),
    database = join(directory, "fixture.sqlite"),
    python = join(directory, "synthetic-python");
  new Store(database).close();
  writeFileSync(
    python,
    `#!/usr/bin/env python3
import sys,json,re
assert sys.argv[1:3]==['-m','personal_radar_connectors.telegram.worker']
assert sys.argv[-1]=='connector'
request=json.load(sys.stdin)
assert 'apiHash' not in request and 'apiId' not in request
rows=[]
for target in request['targets']:
    match=re.search(r'\\d+$',target)
    identifier=str(int(match.group())+1 if match else 1)
    rows.append({'target':target,'status':'complete','channel':{'id':identifier,'title':target,'username':target,'url':'https://t.me/'+target,'broadcast':True,'megagroup':False,'verified':False,'participantsCount':None},'messages':[{'id':'10','channelId':identifier,'username':target,'text':'Synthetic fixture','date':'2026-10-10T00:00:00Z'}],'cursor':None,'watermarkCandidate':'10','scannedCount':1,'filteredCount':0,'filterBreakdown':{},'metadata':{}})
print(json.dumps({'ok':True,'status':'complete','requestCount':len(rows),'channels':rows,'warnings':[]}))
`,
  );
  chmodSync(python, 0o700);
  const requestId = randomUUID(),
    channels = Array.from({ length: 50 }, (_, i) => `source${i}`);
  async function connection(credentials: boolean) {
    const client = new Client({ name: "synthetic-worker-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/telegram-monitoring-mcp.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        ACTIVITY_DB: database,
        TELEGRAM_API_ID: credentials ? "123" : "",
        TELEGRAM_API_HASH: credentials ? "synthetic-test-hash-000000" : "",
        TELEGRAM_PYTHON: python,
        TELEGRAM_SESSION_PATH: join(directory, "unused-session"),
      },
    });
    await client.connect(transport);
    return client;
  }
  let active: Client | undefined;
  try {
    active = await connection(true);
    const planned = await active.callTool({
      name: "telegram_batch_read",
      arguments: { requestId, channels, operation: "recent" },
    });
    expect((planned.structuredContent as any).execute).toBe(false);
    const executed = await active.callTool({
      name: "telegram_batch_read",
      arguments: { requestId, channels, operation: "recent", execute: true },
    });
    expect(executed.isError).not.toBe(true);
    expect((executed.structuredContent as any).status).toBe("complete");
    expect((executed.structuredContent as any).messages).toHaveLength(50);
    await active.close();
    active = await connection(false);
    const saved = await active.callTool({
      name: "telegram_batch_result",
      arguments: { requestId },
    });
    expect(saved.isError).not.toBe(true);
    expect((saved.structuredContent as any).messages).toHaveLength(50);
    const store = Store.openExisting(database);
    try {
      expect(store.entities()).toHaveLength(0);
    } finally {
      store.close();
    }
  } finally {
    await active?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

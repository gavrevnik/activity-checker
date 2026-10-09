import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,existsSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Store} from "../server/store";
import {SyncService} from "../server/sync";
import {AggregatorTools,aggregatorInput} from "../server/aggregator-tools";

let store: Store;
beforeEach(() => {store = new Store(":memory:");});
afterEach(() => {vi.restoreAllMocks(); store.close();});
describe("shared aggregator MCP handlers", () => {
  it("reads all six ordinary sources without network requests", () => {
    const fetch = vi.spyOn(globalThis,"fetch");
    const result = new AggregatorTools(store).status("belgrade");
    expect(new Set(result.map(s=>s.providerId))).toEqual(new Set(["tickets","bilet","afisha","serbia-travel","belgrade-beat","allevents"]));
    expect(result.find(s=>s.providerId==="allevents")?.requiresConfirmation).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the existing SyncService rather than a second ingestion implementation", async () => {
    const source = store.sources().find(s=>s.providerId==="tickets")!;
    const run = vi.spyOn(SyncService.prototype,"run").mockResolvedValue({fetched:0,created:0,updated:0,duplicates:0,filtered:0,errors:0,warnings:[]});
    const result = await new AggregatorTools(store).run({sourceId:source.id});
    expect(run).toHaveBeenCalledWith(source.id,false,expect.objectContaining({confirmed:false}));
    expect(result.requestsUsed).toBe(0);
  });
  it("denies paid providers, URL overrides and AllEvents without reviewed confirmation", async () => {
    const tools = new AggregatorTools(store);
    const paid = store.sources().find(s=>s.providerId==="google-places-api")!;
    const manual = store.sources().find(s=>s.providerId==="allevents")!;
    const run = vi.spyOn(SyncService.prototype,"run");
    await expect(tools.run({sourceId:paid.id})).rejects.toThrow("разрешённые");
    await expect(tools.run({sourceId:manual.id,confirmed:true})).rejects.toThrow("previewId");
    await expect(tools.run({sourceId:manual.id,previewId:"00000000-0000-4000-8000-000000000000"})).rejects.toThrow("confirmed=true");
    expect(()=>aggregatorInput.parse({sourceId:manual.id,url:"https://evil.example",confirmed:true})).toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects a configured source pointing outside its fixed provider domain", async () => {
    const source = store.sources().find(s=>s.providerId==="tickets")!;
    store.db.prepare("UPDATE sources SET url=? WHERE id=?").run("https://other.example/",source.id);
    await expect(new AggregatorTools(store).run({sourceId:source.id})).rejects.toThrow("URL запрещён");
  });
  it("opens an existing DB without migrations, seed or repair of active sync runs", () => {
    const dir = mkdtempSync(join(tmpdir(),"mcp-existing-"));
    const path = join(dir,"fixture.sqlite");
    try {
      expect(()=>Store.openExisting(path)).toThrow();
      expect(existsSync(path)).toBe(false);
      const fixture = new Store(path);
      fixture.db.prepare("INSERT INTO sync_runs(id,sourceId,startedAt,status) VALUES(?,?,?,'running')")
        .run("fixture-run","source-tickets","2026-10-05T10:00:00Z");
      fixture.close();
      const opened = Store.openExisting(path);
      try {expect(opened.db.prepare("SELECT status FROM sync_runs WHERE id='fixture-run'").get()?.status).toBe("running");}
      finally {opened.close();}
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});

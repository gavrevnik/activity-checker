import {expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {Store} from "../server/store";
import {SyncService} from "../server/sync";
import {server} from "../scripts/activity-research-mcp";

it("exposes the shared MCP and serializes database calls without networking",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"research-mcp-"));
  const path=join(dir,"fixture.sqlite");
  new Store(path).close();
  const old=process.env.ACTIVITY_DB;
  process.env.ACTIVITY_DB=path;
  const [a,b]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:"fixture",version:"1"});
  await server.connect(b); await client.connect(a);
  let release!:()=>void, began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const run=vi.spyOn(SyncService.prototype,"run").mockImplementation(async()=>{
    began(); await pending;
    return {fetched:0,created:0,updated:0,duplicates:0,filtered:0,errors:0,warnings:[]};
  });
  try {
    const listed=await client.listTools();
    expect(listed.tools).toHaveLength(9);
    const sync=client.callTool({name:"activity_aggregators_sync",arguments:{sourceId:"source-tickets"}});
    await started;
    const busy=await client.callTool({name:"activity_aggregators_status",arguments:{}});
    expect(busy.isError).toBe(true);
    release(); await sync;
    const status=await client.callTool({name:"activity_aggregators_status",arguments:{}});
    expect(status.isError).not.toBe(true);
    const invalid=await client.callTool({name:"activity_aggregators_sync",arguments:{sourceId:"source-tickets",baseUrl:"https://other.example"}});
    expect(invalid.isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    release();run.mockRestore();await client.close();await server.close();
    if(old===undefined)delete process.env.ACTIVITY_DB;else process.env.ACTIVITY_DB=old;
    rmSync(dir,{recursive:true,force:true});
  }
});

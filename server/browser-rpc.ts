import { createConnection } from "node:net";
export type BrowserRequest = {action:"status"}|{action:"read";url:string;maxChars:number;waitMs?:number}|{action:"search";query:string;count:number};
export type BrowserCaller = (request:BrowserRequest)=>Promise<Record<string,any>>;
export const browserCall:BrowserCaller = request => new Promise((resolve,reject)=>{
 const socket=createConnection({path:'/Users/nikitagavrev/main/life-stack/.agent-stack-tmp/browser-read.sock'});
 const chunks:Buffer[]=[];let size=0;
 socket.setTimeout(95000,()=>socket.destroy(new Error('JavaScript reader timeout')));
 socket.on('connect',()=>socket.end(JSON.stringify(request)));
 socket.on('data',part=>{size+=part.length;if(size>4*1024*1024)socket.destroy(new Error('JavaScript reader response limit'));else chunks.push(part);});
 socket.on('error',()=>reject(new Error('JavaScript browser worker недоступен. Выполните настройку Agent Stack browser service; личный браузер не используется.')));
 socket.on('close',()=>{try{const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!r.ok)throw new Error('Anonymous JavaScript reader failed');resolve(r.result);}catch{reject(new Error('JavaScript reader не смог прочитать публичную страницу; используйте другой источник.'));}});
});

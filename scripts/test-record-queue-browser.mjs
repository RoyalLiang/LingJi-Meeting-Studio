import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
let js=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/queue.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
js=`class ApiError extends Error{};const trace=()=>{};const traceEnabled=()=>false;const api=(...args)=>window.upload(...args);\n${js}`;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/queue.js'?'application/javascript':'text/html');res.end(req.url==='/queue.js'?js:'<!doctype html><title>Queue scenario</title>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{})});const page=await browser.newPage();const url=`http://127.0.0.1:${server.address().port}`;await page.goto(url);
 await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('meeting-studio-audio',1);r.onupgradeneeded=()=>{r.result.createObjectStore('chunks',{keyPath:'key'});r.result.createObjectStore('manifests',{keyPath:'key'});};r.onsuccess=()=>{const db=r.result,tx=db.transaction(['chunks','manifests'],'readwrite');tx.objectStore('chunks').put({key:'r:mic:e:0',recordId:'r',bytes:3200,createdAt:1,chunk:{sessionId:'s',sourceId:'mic',epoch:'e',sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:'a'.repeat(64),pcm:'AA=='}});tx.oncomplete=()=>{db.close();resolve();};};}));
 await page.evaluate(async()=>{const q=await import('/queue.js');q.setQueueRecords(['r']);if(await q.pendingCount()!==1)throw Error('migration lost chunk');window.upload=async()=>{throw Error('offline');};try{await q.drainQueue();}catch{}if(await q.pendingCount()!==1)throw Error('failed send lost chunk');});
 await page.reload();const result=await page.evaluate(async()=>{
   const q=await import('/queue.js');q.setQueueRecords(['r']);const restored=await q.pendingCount();let active=0,maximum=0;const sent=[];
   window.upload=async(path,method,c)=>{active++;maximum=Math.max(maximum,active);sent.push(`${c.sourceId}:${c.sequence}`);await new Promise(r=>setTimeout(r,2));active--;};
   for(const sourceId of ['mic','tab'])for(let sequence=sourceId==='mic'?1:0;sequence<40;sequence++)await q.enqueue('r',{sessionId:'s',sourceId,epoch:'e',sequence,sampleOffset:sequence*1600,sampleCount:1600,sampleRate:16000,digest:'a'.repeat(64),pcm:'AA=='});
   await q.drainQueue();for(const s of ['mic','tab'])if(sent.filter(x=>x.startsWith(s+':')).join()!==Array.from({length:40},(_,i)=>`${s}:${i}`).join())throw Error('ordering');
   if(await q.pendingCount()!==0 || (await q.queueStats()).bytes!==0)throw Error('accounting');return{restored,uploaded:sent.length,maximum,pending:await q.pendingCount()};
 });if(process.argv[2])await writeFile(process.argv[2],JSON.stringify({at:new Date().toISOString(),environment:'headless Chromium, synthetic PCM metadata, real IndexedDB',...result},null,2)+'\n');console.log(result);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}

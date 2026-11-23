import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import net from 'node:net';

const [home,forbidden]=process.argv.slice(2);
const clone=join(fileURLToPath(new URL('.',import.meta.url)),'clone');
const entry=join(clone,'client-backend/services/records/src/desktop-backend.mjs');
const asr=join(clone,'client-backend/local-asr');
const addonPath=join(clone,'runtime/sandbox-bookmarks.node');
const root=join(home,'Library/Caches/LingjiSandboxProbe/backend-'+randomUUID());
const result={phase:'backend-node',node:process.version,home,nodeHome:homedir(),root,externalConnectionsBlocked:0};
let backend,client;
const originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let options=args[0];if(Array.isArray(options))options=options[0];
 const host=typeof options==='object'?options?.host:typeof args[1]==='string'?args[1]:undefined;
 if(host&&!['127.0.0.1','::1','localhost'].includes(host)){result.externalConnectionsBlocked++;throw new Error('probe_external_network_forbidden');}
 return originalConnect.apply(this,args);
};
try{
 assert.equal(home,homedir());assert.match(home,/\/Library\/Containers\/com\.lingji\.sandboxprobe\.[a-f0-9]+\/Data$/);
 assert.equal(process.env.LINGJI_LOCAL_ASR_DIR,asr);assert.equal(process.env.LINGJI_MACOS_SANDBOX_MODULE,addonPath);
 const require=createRequire(import.meta.url),addon=require(addonPath);
 assert.equal(typeof addon.resolveBookmarks,'function');assert.deepEqual(JSON.parse(addon.resolveBookmarks('{}')),[]);result.bookmarkAddonLoaded=true;
 const {startDesktopBackend,startupDiagnostic}=await import(pathToFileURL(entry).href);
 try{backend=await startDesktopBackend({root,workers:false});}catch(error){result.startupDiagnostic=startupDiagnostic(error);throw error;}
 assert.match(backend.url,/^http:\/\/127\.0\.0\.1:\d+$/);assert.ok(backend.session.startsWith('record_session='));
 result.handshake={protocol:1,loopbackUrl:true,sessionPresent:true,sqlite:backend.sqlite,workers:false};
 const response=await fetch(backend.url+'/api/bootstrap',{headers:{Cookie:backend.session},signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);await response.json();result.bootstrapStatus=response.status;
 const id='sandbox-probe:'+randomUUID();await backend.repo.insert({id,kind:'sandbox-probe',value:42});assert.equal((await backend.repo.get(id)).value,42);
 const {LocalAsrClient}=await import(pathToFileURL(join(clone,'client-backend/services/records/src/local-asr.mjs')).href);
 client=new LocalAsrClient(asr,{timeoutMs:120000,idleMs:1000});
 const text=await client.transcribe(Buffer.alloc(16000*2));assert.equal(typeof text,'string');
 result.sherpaWorker={loaded:true,syntheticPcmSeconds:1,textCharacters:text.length};
 await client.close();client=undefined;
 await backend.stop();backend=undefined;
 const database=new DatabaseSync(join(root,'records.sqlite'),{readOnly:true});
 try{assert.equal(database.prepare("SELECT json_extract(data,'$.value') value FROM aggregates WHERE id=?").get(id).value,42);result.sqlitePersistedAfterStop=true;}finally{database.close();}
 let denied;try{await writeFile(resolve(forbidden),'unexpected-backend-sandbox-write\n',{flag:'a'});}catch(error){denied=error.code;}
 assert.ok(['EPERM','EACCES'].includes(denied));result.forbiddenWriteDenied=denied;
 assert.equal(result.externalConnectionsBlocked,0);result.ok=true;
}catch(error){result.ok=false;result.error={name:error.name,code:error.code,message:error.message};process.exitCode=1;}
finally{await client?.close().catch(()=>{});await backend?.stop().catch(()=>{});net.Socket.prototype.connect=originalConnect;}
console.log(JSON.stringify(result));

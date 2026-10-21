import { uploadAudio, ApiError } from '../api';
import { trace, traceEnabled } from '../telemetry';
import type { AudioChunk } from '../model';
interface Pending { key: string; recordId: string; chunk: AudioChunk; bytes: number; createdAt: number }
interface Manifest { key: string; recordId: string; sourceId: string; epoch: string; lastSequence: number }
let saving = 0;
let localBackend = false;
export function setLocalQueueBackend(local: boolean) { localBackend = local; }
const canUpload = () => navigator.onLine || localBackend;
const MAX_BYTES = 48 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
let permittedRecords = new Set<string>(), uploading = false;
let draining: Promise<void> | undefined;
export const setQueueRecords = (ids: string[]) => { permittedRecords = new Set(ids); };
function db() {
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('meeting-studio-audio', 2);
    request.onupgradeneeded = () => {
      const connection=request.result, tx=request.transaction!;
      const chunks=connection.objectStoreNames.contains('chunks') ? tx.objectStore('chunks') : connection.createObjectStore('chunks',{keyPath:'key'});
      const manifests=connection.objectStoreNames.contains('manifests') ? tx.objectStore('manifests') : connection.createObjectStore('manifests',{keyPath:'key'});
      if(!chunks.indexNames.contains('recordId'))chunks.createIndex('recordId','recordId');
      if(!chunks.indexNames.contains('lane'))chunks.createIndex('lane',['recordId','chunk.sourceId','chunk.epoch','chunk.sequence']);
      if(!manifests.indexNames.contains('recordId'))manifests.createIndex('recordId','recordId');
      const stats=connection.createObjectStore('stats',{keyPath:'key'});
      let bytes=0;const cursor=chunks.openCursor();
      cursor.onsuccess=()=>{if(cursor.result){bytes+=cursor.result.value.bytes;cursor.result.continue();}else stats.put({key:'total',bytes});};
    };
    request.onsuccess = () => {request.result.onversionchange=()=>{request.result.close();database=undefined;};resolve(request.result);};
    request.onerror = () => {database=undefined;reject(request.error);};
    request.onblocked = () => reject(new Error('请关闭其他录音页面后重试本地队列升级。'));
  });
}
function result<T>(request:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function localManifests(recordId:string):Promise<Manifest[]>{
  const connection=await db();return result(connection.transaction('manifests').objectStore('manifests').index('recordId').getAll(recordId));
}
export async function pendingCount(recordId?:string){
  const connection=await db(),store=connection.transaction('chunks').objectStore('chunks').index('recordId');
  return (await Promise.all((recordId?[recordId]:[...permittedRecords]).map(id=>result(store.count(id))))).reduce((a,b)=>a+b,0);
}
export async function queueStats(){
  const connection=await db();const total=await result(connection.transaction('stats').objectStore('stats').get('total'));
  return {bytes:total?.bytes||0,count:await pendingCount()};
}
export async function enqueue(recordId:string,chunk:AudioChunk){
  saving++; try {

  const connection=await db(), started=performance.now();
  await new Promise<void>((resolve,reject)=>{
    const tx=connection.transaction(['chunks','manifests','stats'],'readwrite'),chunks=tx.objectStore('chunks'),manifests=tx.objectStore('manifests'),stats=tx.objectStore('stats');
    const key=`${recordId}:${chunk.sourceId}:${chunk.epoch}:${chunk.sequence}`,manifestKey=`${recordId}:${chunk.sourceId}`;
    const previous=chunks.get(key),total=stats.get('total'),manifest=manifests.get(manifestKey);let ready=0,failure:Error|undefined;
    const save=()=>{
      if(++ready!==3)return;
      const bytes=chunk.sampleCount*2,old=previous.result as Pending|undefined;
      if(old && (old.chunk.digest!==chunk.digest || old.chunk.sampleOffset!==chunk.sampleOffset || old.chunk.sampleCount!==chunk.sampleCount))failure=new Error('本地音频标识冲突，原片段已保留。');
      else if((total.result?.bytes||0)-(old?.bytes||0)+bytes>MAX_BYTES)failure=new Error('本地待传音频超过 48 MB；最后一个片段未能保存，录音已暂停。请恢复网络后继续。');
      if(failure){tx.abort();return;}
      chunks.put({key,recordId,chunk,bytes,createdAt:old?.createdAt||Date.now()});
      stats.put({key:'total',bytes:(total.result?.bytes||0)-(old?.bytes||0)+bytes});
      manifests.put({key:manifestKey,recordId,sourceId:chunk.sourceId,epoch:chunk.epoch,lastSequence:Math.max(chunk.sequence,manifest.result?.epoch===chunk.epoch?manifest.result.lastSequence:-1)});
    };
    previous.onsuccess=total.onsuccess=manifest.onsuccess=save;
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure||tx.error||new Error('音频未能保存到浏览器。'));
  });
  if(traceEnabled()){const depth=await queueStats();trace('audio.queue',{bytes:depth.bytes,count:depth.count});}
  trace('audio.local-save',{recordId,sourceId:chunk.sourceId,sequence:chunk.sequence,bytes:chunk.sampleCount*2,durationMs:performance.now()-started});

  } finally { saving--; }
}
function parallelism(){try{return sessionStorage.getItem('meeting-queue-serial')==='1'?1:2;}catch{return 2;}}
const lane=(entry:Pending)=>`${entry.recordId}:${entry.chunk.sourceId}:${entry.chunk.epoch}`;
async function heads(blocked:Set<string>):Promise<Pending[]>{
  const connection=await db(),entries:Pending[]=[];
  for(const id of [...permittedRecords]){
    await new Promise<void>((resolve,reject)=>{
      const request=connection.transaction('chunks').objectStore('chunks').index('lane').openCursor(IDBKeyRange.bound([id],[id,[]]));
      request.onsuccess=()=>{
        const cursor=request.result;if(!cursor||entries.length>=16){resolve();return;}
        const entry=cursor.value as Pending;if(!blocked.has(lane(entry)))entries.push(entry);
        cursor.continue([id,entry.chunk.sourceId,entry.chunk.epoch,Number.MAX_SAFE_INTEGER]);
      };request.onerror=()=>reject(request.error);
    });if(entries.length>=16)break;
  }return entries;
}
async function remove(entry:Pending){
  const connection=await db();await new Promise<void>((resolve,reject)=>{
    const tx=connection.transaction(['chunks','stats'],'readwrite'),chunks=tx.objectStore('chunks'),stats=tx.objectStore('stats');
    const current=chunks.get(entry.key),total=stats.get('total');let ready=0;
    const erase=()=>{if(++ready!==2)return;if(current.result){chunks.delete(entry.key);stats.put({key:'total',bytes:Math.max(0,(total.result?.bytes||0)-current.result.bytes)});}};
    current.onsuccess=total.onsuccess=erase;tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export function drainQueue(onChange?:()=>void): Promise<void>{
  // Finishing capture must join the current upload, then check for its flushed tail.
  if(draining)return draining.then(()=>drainQueue(onChange));
  if(!canUpload())return Promise.resolve();uploading=true;
  draining=run().finally(()=>{uploading=false;draining=undefined;});
  return draining;
  async function run(){
    const blocked=new Set<string>();let failure:unknown;
    while(canUpload()){
      const entries=await heads(blocked);if(!entries.length)break;
      let next=0;
      await Promise.all(Array.from({length:parallelism()}).map(async()=>{
        while(next<entries.length){
          const entry=entries[next++];if(!permittedRecords.has(entry.recordId))continue;
          const started=performance.now();
          trace('audio.queue-age',{recordId:entry.recordId,sourceId:entry.chunk.sourceId,queueMs:Date.now()-entry.createdAt,durationMs:Date.now()-entry.createdAt});
          try{
            await uploadAudio(`/records/${entry.recordId}/audio`,entry.chunk);
            await remove(entry);trace('audio.ack',{recordId:entry.recordId,sourceId:entry.chunk.sourceId,sequence:entry.chunk.sequence,bytes:entry.bytes,durationMs:performance.now()-started});onChange?.();
          }catch(error){
            if(error instanceof ApiError && error.status===410){await remove(entry);onChange?.();}
            else{blocked.add(lane(entry));if(!(error instanceof ApiError && error.status===404))failure ||= error;}
          }
        }
      }));
    }
    if(failure)throw failure;
  }
}
export async function clearRecordAudio(recordId:string){
  const connection=await db();
  // Cursor reads one payload at a time; aggregate byte accounting stays in the same transaction.
  await new Promise<void>((resolve,reject)=>{
    const tx=connection.transaction(['chunks','manifests','stats'],'readwrite'),stats=tx.objectStore('stats');let removed=0;
    const cursor=tx.objectStore('chunks').index('recordId').openCursor(recordId);
    cursor.onsuccess=()=>{if(cursor.result){removed+=cursor.result.value.bytes;cursor.result.delete();cursor.result.continue();}else{const total=stats.get('total');total.onsuccess=()=>stats.put({key:'total',bytes:Math.max(0,(total.result?.bytes||0)-removed)});}};
    const manifests=tx.objectStore('manifests').index('recordId').openCursor(recordId);
    manifests.onsuccess=()=>{if(manifests.result){manifests.result.delete();manifests.result.continue();}};
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
export async function downloadPendingAudio(recordId:string){
  const connection=await db();const entries:Pending[]=await result(connection.transaction('chunks').objectStore('chunks').index('recordId').getAll(recordId));
  if(!entries.length)throw new Error('本机没有这条记录的待传音频。');
  const blob=new Blob([JSON.stringify({format:'meeting-audio-backup/v1',recordId,manifests:await localManifests(recordId),chunks:entries.map(entry=>entry.chunk)})],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`pending-audio-${recordId}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function makeChunk(sourceId: string, epoch: string, sequence: number, sampleOffset: number, buffer: ArrayBuffer, sessionId: string): Promise<AudioChunk> {
  const started=performance.now();
  const bytes = new Uint8Array(buffer); const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  trace('audio.encoded',{sourceId,sequence,bytes:bytes.length,durationMs:performance.now()-started});
  return { sessionId, sourceId, epoch, sequence, sampleOffset, sampleCount: bytes.length / 2, sampleRate: 16000,
    digest: Array.from(hash, b => b.toString(16).padStart(2, '0')).join(''), pcm: btoa(binary) };
}

export async function updateQueueState() {
  const connection = await db(), transaction = connection.transaction(['chunks','stats']);
  const [count, total] = await Promise.all([result(transaction.objectStore('chunks').count()), result(transaction.objectStore('stats').get('total'))]);
  return { pendingBytes: total?.bytes || 0, pendingCount: count, queueBusy: uploading || saving > 0 };
}

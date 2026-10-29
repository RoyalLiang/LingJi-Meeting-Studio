import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {IDBFactory,IDBKeyRange,IDBObjectStore,IDBIndex} from 'fake-indexeddb';
const source=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/queue.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replaceAll('export ','')+'\nObject.assign(exports,{setLocalQueueBackend,ensureAudioCapacity,enqueue,drainQueue,setQueueRecords,pendingCount,localManifests,clearRecordAudio,queueStats,downloadPendingAudio,updateQueueState});';
class ApiError extends Error{constructor(status){super('api');this.status=status;}}
function harness(indexedDB=new IDBFactory(),api=async()=>{},sessionStorage){
  const exports={},downloads=[];const navigator={onLine:true};const document={createElement:()=>({click(){}})};const downloadURL={createObjectURL:blob=>{downloads.push(blob);return "blob:fixture";},revokeObjectURL(){}};vm.runInNewContext(source,{exports,indexedDB,IDBKeyRange,ApiError,api,uploadAudio:(path,chunk)=>api(path,'POST',chunk),navigator,sessionStorage,performance,trace(){},traceEnabled:()=>false,setTimeout,Blob,URL:downloadURL,document,console});return{...exports,indexedDB,navigator,downloads};
}
const chunk=(sourceId='mic',sequence=0,extra={})=>({sessionId:'s',sourceId,epoch:'e',sequence,sampleOffset:sequence*1600,sampleCount:1600,sampleRate:16000,digest:'a'.repeat(64),pcm:'AA==',...extra});
async function legacy(indexedDB){await new Promise((resolve,reject)=>{const open=indexedDB.open('meeting-studio-audio',1);open.onupgradeneeded=()=>{open.result.createObjectStore('chunks',{keyPath:'key'});open.result.createObjectStore('manifests',{keyPath:'key'});};open.onsuccess=()=>{const db=open.result,tx=db.transaction(['chunks','manifests'],'readwrite');tx.objectStore('chunks').put({key:'r:mic:e:0',recordId:'r',chunk:chunk(),bytes:3200,createdAt:1});tx.objectStore('manifests').put({key:'r:mic',recordId:'r',sourceId:'mic',epoch:'e',lastSequence:0});tx.oncomplete=()=>{db.close();resolve();};};open.onerror=()=>reject(open.error);});}
test('v1 migration preserves pending payloads, recovery, exact byte cap and duplicate accounting',async()=>{
  const indexedDB=new IDBFactory();await legacy(indexedDB);const h=harness(indexedDB);h.setQueueRecords(['r']);
  assert.equal(await h.pendingCount(),1);assert.equal((await h.queueStats()).bytes,3200);assert.equal((await h.localManifests('r'))[0].lastSequence,0);
  await h.enqueue('r',chunk());assert.equal((await h.queueStats()).bytes,3200);
  await assert.rejects(h.enqueue('r',chunk('mic',0,{digest:'b'.repeat(64)})),/冲突/);assert.equal(await h.pendingCount(),1);
  await h.enqueue('other',chunk('mic',0,{sampleCount:(512*1024*1024-3200)/2}));await assert.rejects(h.enqueue('r',chunk('mic',1)),/缓存空间不足/);
  assert.equal((await h.queueStats()).bytes,512*1024*1024);await h.clearRecordAudio('other');assert.equal((await h.queueStats()).bytes,3200);
  const recovered=harness(indexedDB);recovered.setQueueRecords(['r']);assert.equal(await recovered.pendingCount(),1);await recovered.drainQueue();assert.equal(await h.pendingCount(),0);assert.equal((await h.queueStats()).bytes,0);
});
test('bounded drain keeps source order and progresses other sources after failures',async()=>{
  const sent=[],active=new Set();let maximum=0;const h=harness(undefined,async(path,method,c)=>{
    assert.ok(!active.has(c.sourceId),'one request per source');active.add(c.sourceId);maximum=Math.max(maximum,active.size);sent.push(`${c.sourceId}:${c.sequence}`);
    await new Promise(resolve=>setTimeout(resolve,1));active.delete(c.sourceId);if(c.sourceId==='bad')throw new Error('offline');
  });h.setQueueRecords(['r']);
  for(const source of ['bad','mic','tab'])for(let i=0;i<20;i++)await h.enqueue('r',chunk(source,i));
  const original=IDBObjectStore.prototype.getAll;IDBObjectStore.prototype.getAll=function(){assert.fail('hot path must not load whole payload store');};
  try{await assert.rejects(h.drainQueue(),/offline/);}finally{IDBObjectStore.prototype.getAll=original;}
  assert.equal(maximum,2);assert.deepEqual(sent.filter(s=>s.startsWith('mic:')),Array.from({length:20},(_,i)=>`mic:${i}`));assert.deepEqual(sent.filter(s=>s.startsWith('bad:')),['bad:0']);assert.equal(await h.pendingCount(),20);
});
test('offline, logout, 404 retention and 410 cleanup preserve account boundaries',async()=>{
  let calls=0;const h=harness(undefined,async()=>{calls++;h.setQueueRecords([]);});h.setQueueRecords(['r']);await h.enqueue('r',chunk('mic',0));await h.enqueue('r',chunk('mic',1));await h.enqueue('other',chunk());
  h.navigator.onLine=false;await h.drainQueue();assert.equal(calls,0);h.navigator.onLine=true;await h.drainQueue();assert.equal(calls,1);assert.equal(await h.pendingCount('r'),1);assert.equal(await h.pendingCount('other'),1);
  const retained=harness(h.indexedDB,async()=>{throw new ApiError(404);});retained.setQueueRecords(['r']);await retained.drainQueue();assert.equal(await retained.pendingCount(),1);
  const deleted=harness(h.indexedDB,async()=>{throw new ApiError(410);});deleted.setQueueRecords(['r']);await deleted.drainQueue();assert.equal(await deleted.pendingCount(),0);assert.equal(await deleted.pendingCount('other'),1);
});


test('serial rollback uses the indexed format without losing pending audio',async()=>{
  let active=0,maximum=0;const h=harness(undefined,async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,1));active--;},{getItem:()=> '1'});h.setQueueRecords(['r']);
  await h.enqueue('r',chunk('mic'));await h.enqueue('r',chunk('tab'));await h.drainQueue();assert.equal(maximum,1);assert.equal(await h.pendingCount(),0);
});

test('local backend drains durable queue without internet while Web queue stays offline',async()=>{
  let uploads=0;const h=harness(new IDBFactory(),async()=>{uploads++;});h.setQueueRecords(['local']);
  h.navigator.onLine=false;await h.enqueue('local',chunk());await h.drainQueue();assert.equal(uploads,0);assert.equal(await h.pendingCount('local'),1);
  h.setLocalQueueBackend(true);await h.drainQueue();assert.equal(uploads,1);assert.equal(await h.pendingCount('local'),0);
});

test('ending capture awaits an upload already draining before reporting saved audio ready',async()=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const h=harness(new IDBFactory(),async()=>{entered();await gate;});h.setQueueRecords(['ending']);
  await h.enqueue('ending',chunk());
  const background=h.drainQueue();await started;
  let finished=false;const finish=h.drainQueue().then(()=>{finished=true;});
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(finished,false,'end-meeting drain must wait for its durable tail, even when background upload owns the queue');
  } finally {release();await Promise.all([background,finish]);}
  assert.equal(await h.pendingCount('ending'),0);
});

test('a slow audio source does not stall the next durable packets of another source',async()=>{
  let releaseSlow,fastFinished;
  const slow=new Promise(resolve=>{releaseSlow=resolve;}),fast=new Promise(resolve=>{fastFinished=resolve;});
  const sent=[],active=new Set();let maximum=0;
  const h=harness(new IDBFactory(),async(_path,_method,c)=>{
    assert.ok(!active.has(c.sourceId),'per-source ordering must remain serial');
    active.add(c.sourceId);maximum=Math.max(maximum,active.size);sent.push(`${c.sourceId}:${c.sequence}`);
    try{if(c.sourceId==='mic')await slow;else if(c.sequence===3)fastFinished();}
    finally{active.delete(c.sourceId);}
  });
  h.setQueueRecords(['meeting']);
  await h.enqueue('meeting',chunk('mic'));
  for(let sequence=0;sequence<4;sequence++)await h.enqueue('meeting',chunk('tab',sequence));
  const draining=h.drainQueue();
  try{
    const completed=await Promise.race([fast.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),200))]);
    assert.equal(completed,true,'fast source should finish its backlog before the slow source ACK is released');
    assert.deepEqual(sent.filter(x=>x.startsWith('tab:')),['tab:0','tab:1','tab:2','tab:3']);
  }finally{releaseSlow();await draining;}
  assert.equal(maximum,2,'the concurrency limit remains two');
  assert.equal(await h.pendingCount('meeting'),0);
});

test('new packets wake a running drain while a different source is waiting for its ACK',async()=>{
  let releaseSlow,firstFast,nextFast;
  const slow=new Promise(resolve=>{releaseSlow=resolve;});
  const first=new Promise(resolve=>{firstFast=resolve;}),next=new Promise(resolve=>{nextFast=resolve;});
  const h=harness(new IDBFactory(),async(_path,_method,c)=>{
    if(c.sourceId==='mic')await slow;
    else if(c.sequence===0)firstFast();else nextFast();
  });
  h.setQueueRecords(['meeting']);await h.enqueue('meeting',chunk('mic'));await h.enqueue('meeting',chunk('tab'));
  const background=h.drainQueue();await first;
  await h.enqueue('meeting',chunk('tab',1));
  try{
    assert.equal(await Promise.race([next.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),200))]),true,'newly saved packets should not await the unrelated source');
  }finally{releaseSlow();await Promise.all([background]);}
  assert.equal(await h.pendingCount('meeting'),0);
});

test('going offline joins active acknowledgements and retains the unsent tail',async()=>{
  let releaseSlow,fastFinished;
  const slow=new Promise(resolve=>{releaseSlow=resolve;}),fast=new Promise(resolve=>{fastFinished=resolve;});
  const sent=[];const h=harness(new IDBFactory(),async(_path,_method,c)=>{
    sent.push(`${c.sourceId}:${c.sequence}`);
    if(c.sourceId==='mic')await slow;else{h.navigator.onLine=false;fastFinished();}
  });
  h.setQueueRecords(['meeting']);await h.enqueue('meeting',chunk('mic'));
  await h.enqueue('meeting',chunk('tab'));await h.enqueue('meeting',chunk('tab',1));
  let settled=false;const draining=h.drainQueue().finally(()=>{settled=true;});await fast;
  try{await new Promise(resolve=>setTimeout(resolve,15));assert.equal(settled,false,'active microphone ACK must stay attached');}
  finally{releaseSlow();await draining;}
  assert.deepEqual(sent,['mic:0','tab:0']);assert.equal(await h.pendingCount('meeting'),1);
  h.navigator.onLine=true;await h.drainQueue();assert.equal(await h.pendingCount('meeting'),0);
});

test('storage selection failure still waits for an active source before rejecting the drain',async()=>{
  let releaseSlow,fastFinished;
  const slow=new Promise(resolve=>{releaseSlow=resolve;}),fast=new Promise(resolve=>{fastFinished=resolve;});
  const h=harness(new IDBFactory(),async(_path,_method,c)=>{if(c.sourceId==='mic')await slow;else fastFinished();});
  h.setQueueRecords(['meeting']);await h.enqueue('meeting',chunk('mic'));await h.enqueue('meeting',chunk('tab'));
  let settled=false;const draining=h.drainQueue().then(()=>null,error=>error).finally(()=>{settled=true;});await fast;
  const original=IDBObjectStore.prototype.index;
  IDBObjectStore.prototype.index=function(name){if(name==='lane')throw new Error('synthetic storage failure');return original.call(this,name);};
  try{
    await new Promise(resolve=>setTimeout(resolve,15));assert.equal(settled,false,'a storage failure must not detach pending ACKs');
    releaseSlow();assert.match((await draining)?.message||'',/synthetic storage failure/);
  }finally{releaseSlow();await draining;IDBObjectStore.prototype.index=original;}
  assert.equal(await h.pendingCount('meeting'),0);
});


test('seventy minutes of dual-source PCM can be retained locally while the service is offline', async()=>{
  const h=harness();h.setQueueRecords(['long']);h.navigator.onLine=false;
  for(const id of ['display','microphone'])for(let i=0;i<280;i++)await h.enqueue('long',chunk(id,i,{sampleCount:240000,sampleOffset:i*240000}));
  assert.equal((await h.queueStats()).bytes,268800000);assert.equal(await h.pendingCount('long'),560);
  assert.equal((await h.localManifests('long')).length,2);
});

test('freeing storage retries capacity estimation without losing the held native head',async()=>{
  const h=harness();h.setQueueRecords(['r']);let usage=100*1024*1024;
  h.navigator.storage={estimate:async()=>({quota:100*1024*1024,usage})};
  await assert.rejects(h.enqueue('r',chunk()),/缓存空间不足/);
  usage=0;await h.enqueue('r',chunk());assert.equal(await h.pendingCount('r'),1);
  assert.equal((await h.localManifests('r'))[0].sampleEnd,1600);
});

test('old v2 manifests recover local PCM end from their last pending packet without a new capture',async()=>{
 const idb=new IDBFactory(),h=harness(idb);h.setQueueRecords(['old']);
 await h.enqueue('old',chunk('display',279,{sampleOffset:70*60*16000-1600}));
 await new Promise((resolve,reject)=>{const open=idb.open('meeting-studio-audio',2);open.onsuccess=()=>{
   const db=open.result,tx=db.transaction('manifests','readwrite'),store=tx.objectStore('manifests'),get=store.get('old:display');
   get.onsuccess=()=>{const old=get.result;delete old.sampleEnd;store.put(old);};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
 };open.onerror=()=>reject(open.error);});
 assert.equal((await h.localManifests('old'))[0].sampleEnd,70*60*16000);
 assert.equal(await h.pendingCount('old'),1);
});


test('pending audio backup reads one payload at a time and preserves the recovery format',async()=>{
 const h=harness();h.setQueueRecords(['backup']);await h.enqueue('backup',chunk('mic'));await h.enqueue('backup',chunk('mic',1));
 const getAll=IDBObjectStore.prototype.getAll;
 IDBObjectStore.prototype.getAll=function(...args){if(this.name==='chunks')assert.fail('backup must not materialize the entire PCM store');return getAll.apply(this,args);};
 try{await h.downloadPendingAudio('backup');}finally{IDBObjectStore.prototype.getAll=getAll;}
 const backup=JSON.parse(await h.downloads[0].text());assert.equal(backup.format,'meeting-audio-backup/v1');assert.equal(backup.recordId,'backup');assert.deepEqual(backup.chunks.map(c=>c.sequence),[0,1]);assert.equal(backup.manifests[0].lastSequence,1);
 assert.equal(await h.pendingCount('backup'),2,'a backup never deletes durable audio');
});


test('old 48 MiB backlog permits a new meeting and a genuinely full queue recovers without deleting data',async()=>{
 const h=harness();h.setQueueRecords(['old','new']);h.navigator.onLine=false;
 await h.enqueue('old',chunk('display',0,{sampleCount:48*1024*1024/2}));
 await h.ensureAudioCapacity();await h.enqueue('new',chunk());
 assert.equal(await h.pendingCount('old'),1);assert.equal(await h.pendingCount('new'),1);
 await h.enqueue('old',chunk('display',1,{sampleCount:(512*1024*1024-48*1024*1024-3200)/2}));
 await assert.rejects(h.ensureAudioCapacity(),/尚未开始录音/);
 assert.equal(await h.pendingCount('new'),1);
 h.navigator.onLine=true;await h.drainQueue();await h.ensureAudioCapacity();
 await h.enqueue('new',chunk('mic',1));assert.equal(await h.pendingCount('new'),1);
});

test('queue wakeups cannot starve an already selected audio packet',async()=>{
 const original=IDBIndex.prototype.openCursor,joined=[];let queries=0,selectedAtUpload=0;
 const h=harness(new IDBFactory(),async()=>{selectedAtUpload=queries;});
 await h.enqueue('r',chunk());h.setQueueRecords(['r']);
 IDBIndex.prototype.openCursor=function(...args){
  const request=original.apply(this,args);
  if(this.name==='lane'&&++queries<=6)joined.push(h.drainQueue());
  return request;
 };
 try{await h.drainQueue();await Promise.all(joined);assert.equal(selectedAtUpload,1,'safety polls must not discard a ready upload and starve persistence');}
 finally{IDBIndex.prototype.openCursor=original;}
});

test('an empty background queue scan does not report saving audio',async()=>{
 const original=IDBIndex.prototype.openCursor,h=harness();h.setQueueRecords(['r']);
 let releaseHead;const ready=new Promise(resolve=>{
  IDBIndex.prototype.openCursor=function(...args){
   const request=original.apply(this,args);
   if(this.name!=='lane')return request;
   return new Proxy(request,{get:(target,key)=>Reflect.get(target,key,target),set(target,key,value){
    if(key==='onsuccess'){target.onsuccess=event=>{releaseHead=()=>value.call(target,event);resolve();};return true;}
    return Reflect.set(target,key,value,target);
   }});
  };
 });
 let draining;
 try{draining=h.drainQueue();await ready;const state=await h.updateQueueState();assert.equal(state.pendingCount,0);assert.equal(state.pendingBytes,0);assert.equal(state.queueBusy,false);}
 finally{releaseHead?.();IDBIndex.prototype.openCursor=original;await draining;}
});

test('finished meeting drains durable tail and unlocks original audio before ASR completes',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {createHash}=await import('node:crypto'),{createRecordServer}=await import('../services/records/src/server.mjs');
 const root=await mkdtemp(join(tmpdir(),'finished-audio-')),app=await createRecordServer({root,databaseUrl:'',port:0,seedDevelopment:false});
 try{
  const address=await app.start(),base=`http://127.0.0.1:${address.port}/api`;
  const login=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'finish-audio@example.test',password:'fixture-password'})});
  const session=await login.json(),headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();};
  const record=await post('/records',{retainAudio:true}),source=await post(`/records/${record.id}/sources`,{kind:'microphone'});
  const h=harness(new IDBFactory(),(path,_method,body)=>post(path,body)),pcm=Buffer.alloc(3200,12);
  for(let sequence=0;sequence<6;sequence++)await h.enqueue(record.id,chunk(source.id,sequence,{sessionId:source.sessionId,epoch:source.epoch,digest:createHash('sha256').update(pcm).digest('hex'),pcm:pcm.toString('base64')}));
  h.setQueueRecords([record.id]);
  await post(`/records/${record.id}/seal`,{sources:[{sourceId:source.id,epoch:source.epoch,lastSequence:5}]});
  await h.drainQueue();
  const saved=await (await fetch(base+`/records/${record.id}`,{headers})).json();
  assert.equal(saved.sources[0].watermark,5);assert.equal(saved.sources[0].lastSequence,5);assert.equal(saved.sources[0].stopped,true);assert.equal(saved.pendingChunks,6,'ASR is separate from persisted audio');
  const playbackCode=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/recording-playback.ts',import.meta.url),'utf8'));
  const {recordingPlaybackState}=await import(`data:text/javascript;base64,${Buffer.from(playbackCode).toString('base64')}`);
  assert.equal(recordingPlaybackState(saved).available,true,'save indicator clears when every tail packet is durable');
  const audio=await fetch(base+`/records/${record.id}/audio/${source.id}`,{headers});assert.equal(audio.status,200);assert.equal((await audio.arrayBuffer()).byteLength,44+6*pcm.length);
  const queue=await h.updateQueueState();assert.equal(queue.pendingCount,0);assert.equal(queue.pendingBytes,0);assert.equal(queue.queueBusy,false);
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});

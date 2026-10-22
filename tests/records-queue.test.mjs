import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
const source=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/queue.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,'').replaceAll('export ','')+'\nObject.assign(exports,{setLocalQueueBackend,enqueue,drainQueue,setQueueRecords,pendingCount,localManifests,clearRecordAudio,queueStats});';
class ApiError extends Error{constructor(status){super('api');this.status=status;}}
function harness(indexedDB=new IDBFactory(),api=async()=>{},sessionStorage){
  const exports={};const navigator={onLine:true};vm.runInNewContext(source,{exports,indexedDB,IDBKeyRange,ApiError,api,uploadAudio:(path,chunk)=>api(path,'POST',chunk),navigator,sessionStorage,performance,trace(){},traceEnabled:()=>false,setTimeout,Blob,URL,console});return{...exports,indexedDB,navigator};
}
const chunk=(sourceId='mic',sequence=0,extra={})=>({sessionId:'s',sourceId,epoch:'e',sequence,sampleOffset:sequence*1600,sampleCount:1600,sampleRate:16000,digest:'a'.repeat(64),pcm:'AA==',...extra});
async function legacy(indexedDB){await new Promise((resolve,reject)=>{const open=indexedDB.open('meeting-studio-audio',1);open.onupgradeneeded=()=>{open.result.createObjectStore('chunks',{keyPath:'key'});open.result.createObjectStore('manifests',{keyPath:'key'});};open.onsuccess=()=>{const db=open.result,tx=db.transaction(['chunks','manifests'],'readwrite');tx.objectStore('chunks').put({key:'r:mic:e:0',recordId:'r',chunk:chunk(),bytes:3200,createdAt:1});tx.objectStore('manifests').put({key:'r:mic',recordId:'r',sourceId:'mic',epoch:'e',lastSequence:0});tx.oncomplete=()=>{db.close();resolve();};};open.onerror=()=>reject(open.error);});}
test('v1 migration preserves pending payloads, recovery, exact byte cap and duplicate accounting',async()=>{
  const indexedDB=new IDBFactory();await legacy(indexedDB);const h=harness(indexedDB);h.setQueueRecords(['r']);
  assert.equal(await h.pendingCount(),1);assert.equal((await h.queueStats()).bytes,3200);assert.equal((await h.localManifests('r'))[0].lastSequence,0);
  await h.enqueue('r',chunk());assert.equal((await h.queueStats()).bytes,3200);
  await assert.rejects(h.enqueue('r',chunk('mic',0,{digest:'b'.repeat(64)})),/冲突/);assert.equal(await h.pendingCount(),1);
  await h.enqueue('other',chunk('mic',0,{sampleCount:(48*1024*1024-3200)/2}));await assert.rejects(h.enqueue('r',chunk('mic',1)),/48 MB/);
  assert.equal((await h.queueStats()).bytes,48*1024*1024);await h.clearRecordAudio('other');assert.equal((await h.queueStats()).bytes,3200);
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
  await h.enqueue('meeting',chunk('tab',1));const joined=h.drainQueue();
  try{
    assert.equal(await Promise.race([next.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),200))]),true,'newly saved packets should not await the unrelated source');
  }finally{releaseSlow();await Promise.all([background,joined]);}
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

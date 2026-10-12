import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source=await readFile(new URL('../apps/web/src/record-subscription.ts',import.meta.url),'utf8');
const javascript=stripTypeScriptTypes(source).replaceAll('export function','function')+'\nexports.subscribeToRecord=subscribeToRecord;exports.applyRecordDelta=applyRecordDelta;';
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function harness(loadRecord=async()=>({cursor:'1'}),applyDelta){
  const streams=[],timers=new Map(),states=[],records=[],errors=[],navigator={onLine:true};let next=0;
  class EventSource{
    constructor(url){this.url=url;this.listeners={};this.closed=false;streams.push(this);}
    addEventListener(name,handler){this.listeners[name]=handler;}
    close(){this.closed=true;}
  }
  const exports={};vm.runInNewContext(javascript,{exports,EventSource,navigator,AbortController,setTimeout(fn,delay){const id=++next;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  const stop=exports.subscribeToRecord({recordId:'test-record',loadRecord,applyDelta,onRecord:r=>records.push(r),onState:s=>states.push(s),onFatal:e=>errors.push(e)});
  return{streams,timers,states,records,errors,navigator,stop,async tick(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();await settle();return timer.delay;}};
}

test('SSE HTTP failure recreates the stream with a freshly validated snapshot cursor',async()=>{
  let cursor=1;const h=harness(async()=>({cursor:String(cursor++)}));await settle();
  const first=h.streams[0];first.readyState=2;first.onerror();
  assert.equal(first.closed,true);assert.equal(h.states.at(-1),'reconnecting');assert.equal(h.timers.size,1);
  first.onerror();assert.equal(h.timers.size,1);
  assert.equal(await h.tick(),1000);assert.equal(h.streams.length,2);assert.match(h.streams[1].url,/after=2$/);
  h.streams[1].onopen();assert.equal(h.states.at(-1),'connected');
  first.onopen();first.onerror();assert.equal(h.states.at(-1),'connected');assert.equal(h.timers.size,0);
  h.stop();assert.ok(h.streams.every(s=>s.closed));
});

test('initial transient API failures retry with capped backoff; auth and access failures stop',async()=>{
  const h=harness(async()=>{throw Object.assign(new Error('unavailable'),{status:503});});await settle();
  const delays=[];for(let i=0;i<7;i++)delays.push(await h.tick());assert.deepEqual(delays,[1000,2000,4000,8000,15000,15000,15000]);h.stop();assert.equal(h.timers.size,0);
  for(const status of [401,403,404,410]){const permanent=harness(async()=>{throw Object.assign(new Error('access denied'),{status});});await settle();assert.equal(permanent.states.at(-1),'unavailable');assert.equal(permanent.errors.length,1);assert.equal(permanent.timers.size,0);assert.equal(permanent.streams.length,0);}
});

test('disposing while loading or retrying cannot create orphaned subscriptions',async()=>{
  let resolve,signal;const h=harness(s=>{signal=s;return new Promise(r=>{resolve=r;});});h.stop();assert.equal(signal.aborted,true);resolve({cursor:'1'});await settle();assert.equal(h.streams.length,0);
  const retry=harness();await settle();retry.streams[0].onerror();retry.stop();assert.equal(retry.timers.size,0);assert.ok(retry.streams[0].closed);
});

test('revocation revalidates access, coalesces event refreshes, and ignores stale snapshots',async()=>{
  let calls=0,release;const h=harness(async()=>{calls++;if(calls===2)return new Promise(r=>{release=r;});if(calls>=4)throw Object.assign(new Error('expired'),{status:401});return{cursor:String(calls)};});await settle();
  const stream=h.streams[0];stream.onmessage();stream.listeners.reset();stream.onmessage();assert.equal(calls,2);release({cursor:'2'});await settle();assert.equal(calls,3);assert.equal(h.records.at(-1).cursor,'3');
  stream.listeners.revoked();await h.tick();assert.equal(h.states.at(-1),'unavailable');assert.equal(h.errors[0].status,401);assert.equal(h.timers.size,0);assert.equal(h.streams.length,1);
  const offline=harness();await settle();offline.navigator.onLine=false;offline.streams[0].onerror();assert.equal(offline.states.at(-1),'offline');assert.equal(offline.timers.size,0);offline.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { createRecord } from '../packages/records/src/record.mjs';
import { queueLearningReview } from '../packages/records/src/learning.mjs';
import { recoverLocalWork } from '../services/records/src/desktop-backend.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('startup recovery does not rewrite unchanged completed history or requeue finished reviews', async () => {
  const ready = createRecord('fixture-owner'); ready.capture = 'completed';
  queueLearningReview(ready, true); ready.learning.status = 'ready';
  const before = structuredClone(ready); let writes = 0;
  const repo = { list: async (kind = 'record') => kind === 'record' ? [structuredClone(ready)] : [], change: async (_id, change) => { writes++; change(ready); } };
  await recoverLocalWork(repo);
  assert.equal(writes, 0, 'unchanged meetings must not serialize and update projections before the window opens');
  assert.deepEqual(ready, before);
});
test('startup still queues a missing review and repairs interrupted work', async () => {
  const record = createRecord('fixture-owner'); record.capture = 'completed';
  record.jobs.push({ id: 'j', status: 'running', lease: 999999, fence: 'old' });
  const repo = { list: async (kind = 'record') => kind === 'record' ? [structuredClone(record)] : [], change: async (_id, change) => change(record) };
  await recoverLocalWork(repo);
  assert.equal(record.jobs[0].status, 'queued'); assert.equal(record.jobs[0].fence, undefined);
  assert.equal(record.learning.enabled, true);
});

test('bootstrap reuses the unfiltered record list to initialize the workspace', async () => {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  const loadBoot = useCallback('), end = app.indexOf('  const refreshProviders', start);
  assert.ok(start >= 0 && end > start);
  const compiled = (await transform(app.slice(start, end) + '\nexports.loadBoot = loadBoot;', { loader: 'ts' })).code;
  const pending = [], calls = []; let initialized=false;
  const sandbox = { exports: {}, useCallback: fn => fn, bootRequest: { current: null }, bootListReady:{current:false}, listView:{current:{query:'',scope:'all'}}, cacheEpoch: { current: 0 }, recordCache: { current: new Map() },
    api: async path => { calls.push(path); if (path === '/bootstrap') return { csrf:'fixture', localAccount: true }; return new Promise(resolve => pending.push(() => resolve(path === '/records' ? { records: [] } : { workspaces: [] }))); },
    setError() {}, setCsrf() {}, setAudioTransport() {}, setLocalQueueBackend() {}, setQueueRecords() {}, setDirectories() {}, setRecords() { initialized=true; }, setBoot() {}, setAuthReady() {}, setLoading() {},
    messageOf: error => error.message, ApiError: class extends Error {}, Promise,
  };
  vm.runInNewContext(compiled, sandbox);
  const loading = sandbox.exports.loadBoot(); await tick();
  try { assert.deepEqual(calls, ['/bootstrap', '/records', '/workspaces']); }
  finally { for (let n=0; n<4; n++) { pending.splice(0).forEach(resolve=>resolve()); await tick(); } await loading; }
  assert.equal(initialized,true,'the already-loaded default list must be shown without a second request');
});

async function listHarness() {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start=app.indexOf('  const loadList = useCallback('),end=app.indexOf('  const refresh = useCallback(',start);
  assert.ok(start>=0&&end>start);
  const code=(await transform('exports.make = (query, scope) => {\n'+app.slice(start,end)+'\nreturn loadList;};',{loader:'ts'})).code;
  const pending=[],state={records:[]};
  const sandbox={exports:{},useCallback:fn=>fn,listRequest:{current:0},listView:{current:{query:'',scope:'old'}},cacheEpoch:{current:0},
    api:path=>new Promise(resolve=>pending.push({path,resolve})),setRecords:records=>{state.records=records;}};
  vm.runInNewContext(code,sandbox);
  return {sandbox,state,pending,make:sandbox.exports.make};
}
test('a slow background list cannot replace the newly selected workspace',async()=>{
  const h=await listHarness(),old=h.make('','old')();
  h.sandbox.listView.current={query:'',scope:'new'};
  const newer=h.make('','new')();
  h.pending[1].resolve({records:[{id:'new-meeting'}]});await newer;
  h.pending[0].resolve({records:[{id:'old-meeting'}]});await old;
  assert.equal(h.state.records[0].id,'new-meeting');
});
test('a late older refresh cannot hide a just-created meeting in the same workspace',async()=>{
  const h=await listHarness(),load=h.make('','old');
  const older=load(),newer=load();
  h.pending[1].resolve({records:[{id:'just-created'}]});await newer;
  h.pending[0].resolve({records:[]});await older;
  assert.equal(h.state.records[0]?.id,'just-created');
});

test('upgrading reschedules an overdue paused recovery without waiting for the old scheduler deadline', async () => {
  const {setAutomation,queueAutomaticMinutes}=await import('../packages/records/src/automation.mjs');
  const now=Date.now(),record=createRecord('fixture-owner');record.capture='paused';
  record.segments=[{id:'s1',revision:1,text:'周五评审',startMs:0,endMs:1000,sourceId:'text-import'}];record.transcriptRevision=1;
  setAutomation(record,{enabled:true},now-60000);
  const job=queueAutomaticMinutes(record,'fixture',now-60000);
  Object.assign(job,{status:'failed',error:'invalid_minutes_schema',failedAt:now-30000});
  record.nextWorkAt=now+3600000;
  let writes=0;
  const repo={list:async(kind='record')=>kind==='record'?[structuredClone(record)]:[],change:async(_id,change)=>{writes++;change(record);}};
  await recoverLocalWork(repo);
  assert.equal(writes,1,'an overdue new recovery rule must recompute the persisted schedule at startup');
  assert.equal(record.capture,'paused');assert.equal(record.minutes,null);
});

test('a late refresh cannot replace the fully saved recording with an older saving snapshot', async () => {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const remember = app.slice(app.indexOf('  const rememberRecord = useCallback('), app.indexOf('  const [minutesActions'));
  const start = app.indexOf('  const refresh = useCallback(');
  const refresh = app.slice(start, app.indexOf('  useEffect(', start));
  const code = (await transform(remember + refresh + '\nexports.rememberRecord=rememberRecord;exports.refresh=refresh;', {loader:'ts'})).code;
  let resolveRequest, displayed;
  const complete = {id:'record',cursor:'12',capture:'completed',retainAudio:true,audioPurged:false,sources:[{stopped:true,lastSequence:4,watermark:4}]};
  const saving = {...complete,cursor:'11',sources:[{stopped:true,lastSequence:4,watermark:3}]};
  const cache = new Map();
  const sandbox = {exports:{},useCallback:fn=>fn,recordCache:{current:cache},mounted:{current:true},activeId:{current:'record'},cacheEpoch:{current:0},setRecord:value=>{displayed=value;},api:()=>new Promise(resolve=>{resolveRequest=resolve;})};
  vm.runInNewContext(code,sandbox);
  const request=sandbox.exports.refresh();
  sandbox.exports.rememberRecord(complete);
  resolveRequest(saving);await request;
  assert.equal(displayed.sources[0].watermark,4,'late GET must not restore the endless 原音保存中 state after durable ACK');
  assert.equal(cache.get('record'),complete);
  const playbackCode=(await transform(await readFile(new URL('../apps/web/src/audio/recording-playback.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})).code;
  const {recordingPlaybackState}=await import('data:text/javascript;base64,'+Buffer.from(playbackCode).toString('base64'));
  assert.equal(recordingPlaybackState(displayed).available,true);
  const delayed=sandbox.exports.refresh(),purged={...complete,cursor:'14',retainAudio:false,audioPurged:true};
  sandbox.exports.rememberRecord(purged);resolveRequest({...complete,cursor:'13'});await delayed;
  assert.equal(recordingPlaybackState(displayed).available,false);
  assert.match(recordingPlaybackState(displayed).label,/原音已清理/);
});


test('initial list effect skips only the hydrated default view, keeping filtered loads live',async()=>{
 const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const start=app.indexOf('  useEffect(() => {\n    if (!authReady) return;',app.indexOf('  const refresh = useCallback('));
 const end=app.indexOf('  useEffect(',start+5);
 assert.ok(start>=0 && end>start);
 const code=(await transform(app.slice(start,end),{loader:'ts'})).code;
 for(const [query,scope,expected] of [['','all',0],['needle','all',1],['','folder',1]]){
  let scheduled=0;const ready={current:true};
  vm.runInNewContext(code,{useEffect:fn=>fn(),authReady:true,bootListReady:ready,query,scope,AbortController,loadList:async()=>{},setError(){},messageOf:()=>'',setTimeout:()=>{scheduled++;return 1;},clearTimeout(){}});
  assert.equal(scheduled,expected,`query=${query}, scope=${scope}`);
  assert.equal(ready.current,false);
 }
});

test('a late seal response cannot restore saving state over the newer durable event',async()=>{
 const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const remember=app.slice(app.indexOf('  const rememberRecord = useCallback('),app.indexOf('  const [minutesActions'));
 const start=app.indexOf('  async function stopCapture('),stop=app.slice(start,app.indexOf('  function captureAllowed(',start));
 const code=(await transform(remember+stop+'\nexports.rememberRecord=rememberRecord;exports.stopCapture=stopCapture;',{loader:'ts'})).code;
 const complete={id:'record',cursor:'12',capture:'completed',title:'fixture',retainAudio:true,audioPurged:false,sources:[{id:'source',epoch:'epoch',stopped:true,lastSequence:4,watermark:4}]};
 const saving={...complete,cursor:'11',capture:'sealed',sources:[{...complete.sources[0],watermark:3}]};
 let displayed,resolveSeal,waiting=false;
 const seal=new Promise(resolve=>{resolveSeal=resolve;});
 const sandbox={exports:{},useCallback:fn=>fn,recordCache:{current:new Map()},mounted:{current:true},activeId:{current:'record'},stopping:{current:false},capture:{current:{stop:async()=>{}}},AbortSignal,
  setRecord:value=>{displayed=value;},setBusy(){},setCapturePhase(){},setError(error){assert.equal(error,'');},setRecording(){},setModal(){},showToast(){},localManifests:async()=>[],upload:async()=>{},refresh:async()=>{},loadList:async()=>{},messageOf:error=>error.message,
  api:async(_path,method)=>{if(method==='GET')return saving;waiting=true;return seal;}};
 vm.runInNewContext(code,sandbox);
 const pending=sandbox.exports.stopCapture();await tick();assert.equal(waiting,true);
 sandbox.exports.rememberRecord(complete);resolveSeal(saving);await pending;
 assert.equal(displayed.sources[0].watermark,4,'late seal HTTP response must not overwrite the acknowledged saved state');
 assert.equal(sandbox.recordCache.current.get('record'),complete);
});

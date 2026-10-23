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

test('bootstrap loads record permissions and workspaces concurrently', async () => {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  const loadBoot = useCallback('), end = app.indexOf('  const refreshProviders', start);
  assert.ok(start >= 0 && end > start);
  const compiled = (await transform(app.slice(start, end) + '\nexports.loadBoot = loadBoot;', { loader: 'ts' })).code;
  const pending = [], calls = [];
  const sandbox = { exports: {}, useCallback: fn => fn, bootRequest: { current: null }, cacheEpoch: { current: 0 }, recordCache: { current: new Map() },
    api: async path => { calls.push(path); if (path === '/bootstrap') return { csrf:'fixture', localAccount: true }; return new Promise(resolve => pending.push(() => resolve(path === '/records' ? { records: [] } : { workspaces: [] }))); },
    setError() {}, setCsrf() {}, setAudioTransport() {}, setLocalQueueBackend() {}, setQueueRecords() {}, setDirectories() {}, setRecords() {}, setBoot() {}, setAuthReady() {}, setLoading() {},
    messageOf: error => error.message, ApiError: class extends Error {}, Promise,
  };
  vm.runInNewContext(compiled, sandbox);
  const loading = sandbox.exports.loadBoot(); await tick();
  try { assert.deepEqual(calls, ['/bootstrap', '/records', '/workspaces']); }
  finally { for (let n=0; n<4; n++) { pending.splice(0).forEach(resolve=>resolve()); await tick(); } await loading; }
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

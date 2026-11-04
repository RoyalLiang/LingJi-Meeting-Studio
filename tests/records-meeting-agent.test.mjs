import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, copyFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as message, fauxToolCall as call } from '@earendil-works/pi-ai/providers/faux';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord } from '../packages/records/src/record.mjs';
import { createMeetingAgentRuntime } from '../services/records/src/meeting-agent.mjs';
import { Harness, defineDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const model = { provider: 'meeting-test', modelId: 'test' };
function provider(responses = []) {
  const fake = fauxProvider({ provider: model.provider, models: [{id:model.modelId}], tokensPerSecond: Infinity });
  fake.setResponses(responses); const models = createModels(); models.setProvider(fake.provider); return { fake, models, model };
}
function result(records) {
  return { summary: '独立复盘', decisions: records.map(record => ({ text: '保持人工纪要', evidence: [{ recordId: record.id, segmentId: record.segments[0].id, revision: record.segments[0].revision }] })), actions: [] };
}
const reads = records => message(records.map(record => call('read_selected_meeting', {recordId:record.id})), {stopReason:'toolUse'});
const request = (records, requestId = 'request-1', prompt = '复盘所选会议') => ({ recordIds: records.map(record=>record.id), requestId, prompt, scopeConfirmed:true });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'meeting-agent-test-')), repo = await createRepository({root});
  let runtime;
  t.after(async()=>{await runtime?.close();await repo.close();await rm(root,{recursive:true,force:true});});
  const records = [];
  for (const title of ['产品复盘','体验讨论']) {
    const record = createRecord('owner',{title}); record.capture='completed';record.transcriptRevision=7;record.minutesRevision=3;
    record.segments=[{id:'segment-'+records.length,revision:1,text:'决定保留人工纪要。',speaker:'林',startMs:0,endMs:1000}];record.minutes={summary:'人工纪要'};
    await repo.insert(record);records.push(record);
  }
  return {root,repo,records,async open(options={}) {runtime=await createMeetingAgentRuntime({repo,...options});return runtime;},async close(){await runtime?.close();runtime=undefined;}};
}
async function settled(runtime,id,owner='owner') {
  for(let i=0;i<200;i++){const task=await runtime.get(owner,id);if(['completed','failed','blocked','cancelled'].includes(task.status))return task;await delay(10);}
  throw new Error('meeting agent did not settle');
}
async function piFiles(root) { return (await readdir(join(root,'meeting-agent-jobs'))).filter(name=>name.endsWith('.sqlite')); }
async function piText(root,rootOnly=false) {
  const files=[join(root,'meeting-agent.sqlite'),...(rootOnly?[]:(await piFiles(root)).map(name=>join(root,'meeting-agent-jobs',name)))],text=[];
  for(const file of files){const db=new DatabaseSync(file,{readOnly:true});try{for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all())text.push(JSON.stringify(db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()));}finally{db.close();}}
  return text.join('\n');
}
async function waitUntil(check) { for(let i=0;i<200;i++){if(await check())return;await delay(10);}throw new Error('retention did not finish'); }

test('Pi reads selected real repository snapshots, validates references, isolates owners and deduplicates requests',async t=>{
  const f=await fixture(t),p=provider([reads(f.records),context=>{
    const tools=context.messages.filter(item=>item.role==='toolResult');assert.equal(tools.length,2);assert.ok(tools.every(item=>!item.isError));return message(JSON.stringify(result(f.records)));
  }]);
  const runtime=await f.open(p),input=request(f.records);
  const [a,b]=await Promise.all([runtime.request('owner',input),runtime.request('owner',input)]);assert.equal(a.id,b.id);
  const done=await settled(runtime,a.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.preview,'独立复盘');assert.equal(done.stale,false);assert.deepEqual(done.result,result(f.records));assert.equal(p.fake.state.callCount,2);
  assert.deepEqual((await f.repo.get(f.records[0].id)).minutes,{summary:'人工纪要'});
  await assert.rejects(runtime.request('owner',{...input,prompt:'different'}),{code:'agent_request_conflict'});
  await assert.rejects(runtime.get('other',a.id),{code:'agent_task_not_found'});await assert.rejects(runtime.cancel('other',a.id),{code:'agent_task_not_found'});assert.deepEqual(await runtime.list('other'),[]);
  await assert.rejects(runtime.request('other',request(f.records)),{code:'agent_scope_denied'});
  const other=createRecord('other',{title:'另一账户'});other.segments=[{id:'other-segment',revision:1,text:'另一账户的独立讨论',startMs:0,endMs:10}];await f.repo.insert(other);
  p.fake.setResponses([context=>{assert.ok(f.records.every(record=>!JSON.stringify(context).includes(record.id)));return reads([other]);},message(JSON.stringify(result([other])))]);
  const isolated=await runtime.request('other',request([other],'other-owned'));assert.equal((await settled(runtime,isolated.id,'other')).status,'completed');
  await assert.rejects(runtime.request('owner',{...input,scopeConfirmed:false}),{code:'agent_scope_required'});
  await assert.rejects(createMeetingAgentRuntime({repo:f.repo,...p}),{code:'agent_runtime_busy'});
});

test('tool scope errors, fabricated references and skipped reads cannot become successful results',async t=>{
  const f=await fixture(t),p=provider(),runtime=await f.open(p),foreign=createRecord('other',{});await f.repo.insert(foreign);
  p.fake.setResponses([message(call('read_selected_meeting',{recordId:foreign.id}),{stopReason:'toolUse'}),context=>{assert.equal(context.messages.find(item=>item.role==='toolResult').isError,true);return message(JSON.stringify(result(f.records.slice(0,1))));}]);
  let task=await runtime.request('owner',request(f.records.slice(0,1),'outside'));assert.equal((await settled(runtime,task.id)).error,'invalid_agent_output');
  const bad=result(f.records.slice(0,1));bad.decisions[0].evidence[0].revision=999;
  p.fake.setResponses([reads(f.records.slice(0,1)),message(JSON.stringify(bad))]);task=await runtime.request('owner',request(f.records.slice(0,1),'bad'));assert.equal((await settled(runtime,task.id)).error,'invalid_agent_output');
  p.fake.setResponses([message(JSON.stringify(result(f.records.slice(0,1))))]);task=await runtime.request('owner',request(f.records.slice(0,1),'unread'));assert.equal((await settled(runtime,task.id)).error,'invalid_agent_output');
});

test('source revisions remain frozen and manual edits produce a stale independent result',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers(),p=provider([reads(f.records.slice(0,1)),async()=>{entered.resolve();await release.promise;return message(JSON.stringify(result(f.records.slice(0,1))));}]);
  const runtime=await f.open(p),task=await runtime.request('owner',request(f.records.slice(0,1)));await entered.promise;
  await f.repo.change(f.records[0].id,record=>{record.minutesRevision++;record.minutes={summary:'人工新编辑'};record.transcriptRevision++;record.segments[0].revision++;});release.resolve();
  const done=await settled(runtime,task.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.stale,true);assert.equal(done.sources[0].transcriptRevision,7);assert.equal(done.result.decisions[0].evidence[0].revision,1);assert.equal((await f.repo.get(f.records[0].id)).minutes.summary,'人工新编辑');
});

test('deleted and expired sources suppress saved results and cannot start new tasks',async t=>{
  const f=await fixture(t),p=provider([reads(f.records.slice(0,1)),message(JSON.stringify(result(f.records.slice(0,1))))]),runtime=await f.open(p);
  const task=await runtime.request('owner',request(f.records.slice(0,1)));assert.equal((await settled(runtime,task.id)).status,'completed');
  await f.repo.change(f.records[0].id,record=>{record.deleted=true;});const hidden=await runtime.get('owner',task.id);assert.equal(hidden.status,'blocked');assert.equal(hidden.result,undefined);assert.equal(hidden.preview,'');
  await assert.rejects(runtime.request('owner',request(f.records.slice(0,1),'deleted')),{code:'agent_source_unavailable'});
  await f.repo.change(f.records[1].id,record=>{record.deleteAt='2000-01-01T00:00:00.000Z';});await assert.rejects(runtime.request('owner',request(f.records.slice(1),'expired')),{code:'agent_source_unavailable'});
});

test('Pi queues tasks and cancellation aborts the real model invocation without starting queued work',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),aborted=Promise.withResolvers(),p=provider([async(_context,options)=>{entered.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));aborted.resolve();return message('aborted',{stopReason:'aborted'});}]),runtime=await f.open(p);
  const first=await runtime.request('owner',request(f.records,'first'));await entered.promise;const queued=await runtime.request('owner',request(f.records,'second'));assert.equal(queued.status,'queued');assert.equal(p.fake.state.callCount,1);
  assert.ok(['cancelling','cancelled'].includes((await runtime.cancel('owner',queued.id)).status));assert.equal((await settled(runtime,queued.id)).status,'cancelled');
  assert.ok(['cancelling','cancelled'].includes((await runtime.cancel('owner',first.id)).status));assert.equal((await settled(runtime,first.id)).status,'cancelled');await aborted.promise;assert.equal(p.fake.state.callCount,1);
});

test('configured JSON bridge performs a real Pi tool loop through the existing LLM transport',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.store,false);if(calls===2)assert.ok(JSON.stringify(body).includes('决定保留人工纪要。'));return new Response(JSON.stringify({status:'completed',output_text:JSON.stringify(calls===1?{toolCalls:[{name:'read_selected_meeting',arguments:{recordId:f.records[0].id}}]}:{result:result(f.records.slice(0,1))})}),{headers:{'content-type':'application/json'}});});
  const runtime=await f.open({env:{LLM_API_KEY:'explicit-test-key',LLM_MODEL:'fixture-http',LLM_API_URL:'https://fixture.invalid/responses',LLM_PROTOCOL:'responses'}});
  const task=await runtime.request('owner',request(f.records.slice(0,1)));const done=await settled(runtime,task.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(calls,2);
});

test('the configured bridge also preserves the existing Chat Completions protocol',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.response_format.type,'json_object');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?{toolCalls:[{name:'read_selected_meeting',arguments:{recordId:f.records[0].id}}]}:{result:result(f.records.slice(0,1))})}}]}),{headers:{'content-type':'application/json'}});});
  const runtime=await f.open({env:{LLM_API_KEY:'explicit-test-key',LLM_MODEL:'fixture-http',LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_PROTOCOL:'chat-completions'}});
  const task=await runtime.request('owner',request(f.records.slice(0,1)));assert.equal((await settled(runtime,task.id)).status,'completed');assert.equal(calls,2);
});

test('the host deadline cooperatively stops the Pi model and records an explicit timeout',async t=>{
  const f=await fixture(t),aborted=Promise.withResolvers(),p=provider([async(_context,options)=>{await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));aborted.resolve();return message('aborted',{stopReason:'aborted'});}]);
  const runtime=await f.open({...p,timeoutMs:50}),task=await runtime.request('owner',request(f.records));const done=await settled(runtime,task.id);await aborted.promise;assert.equal(done.status,'failed');assert.equal(done.error,'agent_timeout');
});

test('sources are checked again after model completion, not only before reading',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers(),p=provider([reads(f.records.slice(0,1)),async()=>{entered.resolve();await release.promise;return message(JSON.stringify(result(f.records.slice(0,1))));}]);
  const runtime=await f.open(p),task=await runtime.request('owner',request(f.records.slice(0,1)));await entered.promise;await f.repo.change(f.records[0].id,record=>{record.owner='other';});release.resolve();const done=await settled(runtime,task.id);assert.equal(done.status,'blocked');assert.equal(done.error,'agent_scope_denied');assert.equal(done.result,undefined);
});

test('missing model configuration, oversized sources and invalid admission fail explicitly',async t=>{
  const f=await fixture(t),runtime=await f.open({env:{}});await assert.rejects(runtime.request('owner',request(f.records)),{code:'minutes_not_configured'});
  await assert.rejects(runtime.request('owner',{...request(f.records),prompt:'x'.repeat(2001)}),{code:'invalid_agent_request'});await f.close();
  const p=provider(),configured=await f.open(p);await f.repo.change(f.records[0].id,record=>{record.segments[0].text='x'.repeat(2000001);});await assert.rejects(configured.request('owner',request(f.records)),{code:'agent_input_too_large'});
});

test('SIGKILL recovery resumes the committed Pi tool checkpoint and completed requests are never replayed',async t=>{
  const f=await fixture(t),record=f.records[0],moduleUrl=pathToFileURL(join(process.cwd(),'services/records/src/meeting-agent.mjs')).href,repoUrl=pathToFileURL(join(process.cwd(),'services/records/src/repository.mjs')).href;
  const script=`import {createMeetingAgentRuntime} from ${JSON.stringify(moduleUrl)};import {createRepository} from ${JSON.stringify(repoUrl)};import {createModels} from '@earendil-works/pi-ai/models';import {fauxProvider,fauxAssistantMessage as message,fauxToolCall as call} from '@earendil-works/pi-ai/providers/faux';const repo=await createRepository({root:${JSON.stringify(f.root)}});const fake=fauxProvider({provider:'meeting-test',models:[{id:'test'}],tokensPerSecond:Infinity});const models=createModels();models.setProvider(fake.provider);fake.setResponses([message(call('read_selected_meeting',{recordId:${JSON.stringify(record.id)}}),{stopReason:'toolUse'}),async()=>{console.log('CHECKPOINT_READY');await new Promise(()=>{});}]);const runtime=await createMeetingAgentRuntime({repo,models,model:{provider:'meeting-test',modelId:'test'}});console.log('TASK:'+JSON.stringify(await runtime.request('owner',${JSON.stringify(request([record],'crash'))})));`;
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{cwd:process.cwd(),env:{PATH:process.env.PATH,TMPDIR:tmpdir()},stdio:['ignore','pipe','pipe']});let output='',errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('checkpoint timeout '+errors)),5000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);if(!output.includes('CHECKPOINT_READY'))reject(new Error('worker exited '+errors));});child.stdout.on('data',bytes=>{output+=bytes;if(output.includes('CHECKPOINT_READY')){clearTimeout(timer);resolve();}});});
  const original=JSON.parse(output.split('\n').find(line=>line.startsWith('TASK:')).slice(5));const exit=once(child,'exit');child.kill('SIGKILL');assert.equal((await exit)[1],'SIGKILL');
  const p=provider([context=>{assert.ok(context.messages.some(item=>item.role==='toolResult'&&!item.isError));return message(JSON.stringify(result([record])));}]),runtime=await f.open(p);
  const done=await settled(runtime,original.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal((await runtime.request('owner',request([record],'crash'))).id,original.id);assert.equal(p.fake.state.callCount,1);await f.close();
  const againProvider=provider(),again=await f.open(againProvider);assert.equal((await again.get('owner',original.id)).status,'completed');assert.equal(againProvider.fake.state.callCount,0);
});

test('retention deletes completed private histories while preserving valid task storage and idempotent tombstones',async t=>{
  const f=await fixture(t),erased='PI_ERASE_COMPLETED_CANARY',kept='PI_KEEP_VALID_CANARY';
  await f.repo.change(f.records[0].id,record=>{record.title=erased;record.segments[0].text=erased;});await f.repo.change(f.records[1].id,record=>{record.segments[0].text=kept;});
  const aResult={...result(f.records.slice(0,1)),summary:erased},bResult={...result(f.records.slice(1)),summary:kept},p=provider([reads(f.records.slice(0,1)),message(JSON.stringify(aResult))]);
  const runtime=await f.open({...p,retentionPollMs:20}),input=request(f.records.slice(0,1),'erase-completed',erased),a=await runtime.request('owner',input);assert.equal((await settled(runtime,a.id)).status,'completed');
  p.fake.setResponses([reads(f.records.slice(1)),message(JSON.stringify(bResult))]);const b=await runtime.request('owner',request(f.records.slice(1),'keep-valid'));assert.equal((await settled(runtime,b.id)).status,'completed');
  assert.ok((await piText(f.root)).includes(erased),'canary must actually have reached Pi before cleanup');assert.ok(!(await piText(f.root,true)).includes(erased),'scheduler must never contain meeting text, prompt or result');
  await f.repo.change(f.records[0].id,record=>{record.deleted=true;});await waitUntil(async()=>(await piFiles(f.root)).length===1);
  const text=await piText(f.root);assert.ok(!text.includes(erased));assert.ok(text.includes(kept));const hidden=await runtime.get('owner',a.id);assert.equal(hidden.status,'blocked');assert.equal(hidden.prompt,'');assert.deepEqual(hidden.sources,[]);assert.equal(hidden.result,undefined);assert.equal((await runtime.request('owner',input)).id,a.id);
  await f.close();const again=await f.open(provider());assert.equal((await again.get('owner',b.id)).result.summary,kept);assert.ok(!(await piText(f.root)).includes(erased));
});

test('startup expiry removes task databases and crash-orphan storage before serving requests',async t=>{
  const f=await fixture(t),marker='PI_ERASE_ON_START_CANARY';await f.repo.change(f.records[0].id,record=>{record.segments[0].text=marker;});
  const p=provider([reads(f.records.slice(0,1)),message(JSON.stringify({...result(f.records.slice(0,1)),summary:marker}))]),runtime=await f.open(p),task=await runtime.request('owner',request(f.records.slice(0,1)));assert.equal((await settled(runtime,task.id)).status,'completed');await f.close();
  const file=(await piFiles(f.root))[0];await copyFile(join(f.root,'meeting-agent-jobs',file),join(f.root,'meeting-agent-jobs',randomUUID()+'.sqlite'));assert.ok((await piText(f.root)).includes(marker));
  await f.repo.change(f.records[0].id,record=>{record.deleteAt='2000-01-01T00:00:00.000Z';});await f.open(provider());assert.deepEqual(await piFiles(f.root),[]);assert.ok(!(await piText(f.root)).includes(marker));
});

test('automatic retention aborts a live model and removes committed tool context without an API read',async t=>{
  const f=await fixture(t),marker='PI_ERASE_LIVE_CANARY';await f.repo.change(f.records[0].id,record=>{record.segments[0].text=marker;});
  const entered=Promise.withResolvers(),aborted=Promise.withResolvers(),p=provider([reads(f.records.slice(0,1)),async(_context,options)=>{entered.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));aborted.resolve();return message('aborted',{stopReason:'aborted'});}]);
  const runtime=await f.open({...p,retentionPollMs:20}),task=await runtime.request('owner',request(f.records.slice(0,1)));await entered.promise;assert.ok((await piText(f.root)).includes(marker));
  await f.repo.change(f.records[0].id,record=>{record.deleted=true;});await aborted.promise;await waitUntil(async()=>(await piFiles(f.root)).length===0);assert.ok(!(await piText(f.root)).includes(marker));assert.equal((await runtime.get('owner',task.id)).status,'blocked');assert.equal(p.fake.state.callCount,2);
});

test('unpublished legacy storage fails closed instead of resuming plaintext scheduler inputs',async t=>{
  const f=await fixture(t),legacy=defineDoc({kind:'meeting.requests.v1',scope:'session',version:1,initial:()=>({privateText:'LEGACY_SYNTHETIC_CANARY'}),checkpointWhen:()=>true});
  const p=provider(),old=await Harness.open(await openNodeSqliteStorage(join(f.root,'meeting-agent.sqlite')),{models:p.models,registry:createRegistry()},BACKGROUND_CONTEXT);await old.commit(async tx=>{await tx.doc(legacy);},BACKGROUND_CONTEXT);await old.close(BACKGROUND_CONTEXT);
  await assert.rejects(f.open(provider()),{code:'agent_storage_upgrade_required'});
});

test('reopen recovery shares one pending job Harness with concurrent API reads and cancellation',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),firstProvider=provider([reads(f.records.slice(0,1)),async(_context,options)=>{entered.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));return message('closed',{stopReason:'aborted'});}]);
  const first=await f.open(firstProvider),task=await first.request('owner',request(f.records.slice(0,1)));await entered.promise;await f.close();
  const opening=Promise.withResolvers(),release=Promise.withResolvers();let opens=0;t.after(()=>release.resolve());
  const nextProvider=provider([async(_context,options)=>{await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});return message('cancelled',{stopReason:'aborted'});}]);
  const runtime=await f.open({...nextProvider,openJobStorage:async path=>{opens++;opening.resolve();await release.promise;return openNodeSqliteStorage(path);}});await opening.promise;
  const get=runtime.get('owner',task.id),list=runtime.list('owner'),cancel=runtime.cancel('owner',task.id);await delay(20);assert.equal(opens,1);release.resolve();
  assert.equal((await get).id,task.id);assert.equal((await list)[0].id,task.id);assert.ok(['cancelling','cancelled'].includes((await cancel).status));assert.equal((await settled(runtime,task.id)).status,'cancelled');assert.equal(opens,1);
});

for (const compressAggregates of [false, true]) {
  test(`Record access metadata stays small and changes transactionally without events, compressed=${compressAggregates}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'meeting-agent-access-'));
    const repo = await createRepository({ root, databaseUrl: '', compressAggregates });
    t.after(async () => { await repo.close(); await rm(root, { recursive: true, force: true }); });
    const record = createRecord('access-owner');
    record.segments = [{ id: 'access-segment', revision: 1, text: 'sensitive-source-'.repeat(5000), startMs: 0, endMs: 1 }];
    await repo.insert(record);
    const initial = (await repo.getRecordAccess([record.id, record.id, 'missing']))[0];
    assert.deepEqual(Object.keys(initial).sort(), ['deleteAt', 'deleted', 'id', 'kind', 'owner', 'version']);
    assert.equal(initial.kind, 'record'); assert.equal(initial.owner, 'access-owner'); assert.equal(initial.deleted, false);
    assert.equal((await repo.getRecordAccess([])).length, 0); assert.ok(!JSON.stringify(initial).includes('sensitive-source'));
    assert.equal((await repo.getRecordAccess([record.id])).length, 1);
    await assert.rejects(repo.change(record.id, value => { value.owner = 'rolled-back'; throw new Error('rollback'); }));
    assert.deepEqual((await repo.getRecordAccess([record.id]))[0], initial);
    await repo.changeMany([record.id], values => { values[0].segments[0].revision++; values[0].minutesRevision++; });
    const changed = (await repo.getRecordAccess([record.id]))[0]; assert.notEqual(changed.version, initial.version);
    assert.equal((await repo.get(record.id)).cursor, record.cursor, 'a write without emit still invalidates the access token');
    await repo.change(record.id, value => { value.owner = 'next-owner'; value.deleted = true; value.deleteAt = '2000-01-01T00:00:00.000Z'; });
    const denied = (await repo.getRecordAccess([record.id]))[0];
    assert.equal(denied.owner, 'next-owner'); assert.equal(denied.deleted, true); assert.equal(denied.deleteAt, '2000-01-01T00:00:00.000Z');
    assert.notEqual(denied.version, changed.version);
    const db = new DatabaseSync(join(root, 'records.sqlite'));
    try { db.prepare("UPDATE record_feed_meta SET data=json_remove(data,'$.writeVersion') WHERE id=?").run(record.id); } finally { db.close(); }
    assert.equal((await repo.getRecordAccess([record.id]))[0].version, record.cursor, 'legacy projections use their cursor until the next write');
    await repo.change(record.id, value => { value.kind = 'workspace'; });
    assert.deepEqual(await repo.getRecordAccess([record.id]), [], 'a changed aggregate kind invalidates its record projection');
  });
}

test('terminal Pi retention and task lists use metadata without rereading bodies, while ownership loss still purges automatically', async t => {
  const f = await fixture(t), p = provider([reads(f.records), message(JSON.stringify(result(f.records)))]);
  const runtime = await f.open({ ...p, retentionPollMs: 20 });
  const task = await runtime.request('owner', request(f.records)); assert.equal((await settled(runtime, task.id)).status, 'completed');
  p.fake.setResponses([reads(f.records), message(JSON.stringify(result(f.records)))]);
  const second = await runtime.request('owner', request(f.records, 'shared-sources')); assert.equal((await settled(runtime, second.id)).status, 'completed');
  let bodies = 0, metadata = 0;
  const get = f.repo.get.bind(f.repo), access = f.repo.getRecordAccess.bind(f.repo);
  t.mock.method(f.repo, 'get', async id => { bodies++; return get(id); });
  t.mock.method(f.repo, 'getRecordAccess', async ids => { metadata++; assert.equal(ids.length, new Set(ids).size); return access(ids); });
  for (let i = 0; i < 10; i++) { assert.equal((await runtime.get('owner', task.id)).stale, false); assert.equal((await runtime.list('owner')).length, 2); }
  const before = metadata; await delay(80); assert.ok(metadata > before, 'retention remains active'); assert.equal(bodies, 0);
  await f.repo.change(f.records[0].id, record => { record.owner = 'another-owner'; });
  await waitUntil(async () => (await piFiles(f.root)).length === 0);
  const hidden = await runtime.get('owner', task.id); assert.equal(hidden.status, 'blocked'); assert.equal(hidden.error, 'agent_scope_denied');
  assert.equal(hidden.result, undefined); assert.equal(bodies, 0, 'revocation cleanup must not decode source bodies');
});

test('Pi hash cache invalidates exactly after source writes without requiring an emitted cursor or version change', async t => {
  const f = await fixture(t), records = f.records.slice(0, 1), p = provider([reads(records), message(JSON.stringify(result(records)))]);
  const runtime = await f.open(p), task = await runtime.request('owner', request(records));
  assert.equal((await settled(runtime, task.id)).stale, false);
  p.fake.setResponses([reads(records), message(JSON.stringify(result(records)))]);
  const second = await runtime.request('owner', request(records, 'shared-sources')); assert.equal((await settled(runtime, second.id)).status, 'completed');
  let bodies = 0; const get = f.repo.get.bind(f.repo);
  t.mock.method(f.repo, 'get', async id => { bodies++; return get(id); });
  await f.repo.change(records[0].id, record => { record.minutes.summary = 'changed without incrementing versions'; });
  const listed = await runtime.list('owner'); assert.equal(listed.length, 2); assert.ok(listed.every(item => item.stale)); assert.equal(bodies, 1, 'concurrent tasks sharing a source share the body read');
  await runtime.get('owner', task.id); await runtime.list('owner'); assert.equal(bodies, 1);
  await f.repo.change(records[0].id, record => { record.minutes.summary = '人工纪要'; });
  assert.equal((await runtime.get('owner', task.id)).stale, false); assert.equal(bodies, 2);
  assert.deepEqual((await runtime.get('owner', task.id)).result, result(records)); assert.equal(bodies, 2);
});

test('duplicated minutes evidence does not reject a normal full meeting or alter frozen source hashes',async t=>{
 const f=await fixture(t),record=f.records[0];
 record.segments=Array.from({length:200},(_,i)=>({id:`long-${i}`,revision:1,text:'会议讨论内容'.repeat(20),startMs:i*1000,endMs:(i+1)*1000}));
 record.minutes={title:'会议',sections:[],actions:[],evidenceSnapshot:structuredClone(record.segments)};
 await f.repo.change(record.id,value=>Object.assign(value,record));
 let wire='';const respond=context=>{const output=context.messages.filter(item=>item.role==='toolResult').at(-1);const text=output.content.filter(part=>part.type==='text').map(part=>part.text).join('');const page=JSON.parse(text);wire+=page.content||text;if(page.nextPage!==undefined)return message(call('read_selected_meeting',{recordId:record.id,page:page.nextPage}),{stopReason:'toolUse'});return message(JSON.stringify(result([record])));};const p=provider([reads([record]),...Array.from({length:30},()=>respond)]);
 const runtime=await f.open(p),task=await runtime.request('owner',request([record],'normal-long'));
 const done=await settled(runtime,task.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(wire.split(record.segments[0].text).length-1,200);assert.equal((await runtime.get('owner',task.id)).stale,false);
});

test('configured streaming bridge publishes readable Markdown before completion',async t=>{
 const f=await fixture(t),gate=Promise.withResolvers();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{
  if(++calls===1)return new Response(JSON.stringify({status:'completed',output_text:JSON.stringify({toolCalls:[{name:'read_selected_meeting',arguments:{recordId:f.records[0].id}}]})}),{headers:{'content-type':'application/json'}});
  const value={...result(f.records.slice(0,1)),summary:'## 已确认\n- **立即**显示 Markdown'};
  const json=JSON.stringify({result:value}),cut=json.indexOf('","decisions"');
  const encoder=new TextEncoder(),event=value=>encoder.encode('data: '+JSON.stringify(value)+'\n\n');
  return new Response(new ReadableStream({async start(controller){
   controller.enqueue(event({type:'response.output_text.delta',delta:json.slice(0,cut)}));
   await gate.promise;controller.enqueue(event({type:'response.output_text.delta',delta:json.slice(cut)}));
   controller.enqueue(event({type:'response.completed',response:{status:'completed'}}));controller.close();
  }}),{headers:{'content-type':'text/event-stream'}});
 });
 const runtime=await f.open({env:{LLM_API_KEY:'explicit-test-key',LLM_MODEL:'fixture-stream',LLM_API_URL:'https://fixture.invalid/responses',LLM_PROTOCOL:'responses'}});
 const task=await runtime.request('owner',request(f.records.slice(0,1)));
 try{await waitUntil(async()=>Boolean((await runtime.get('owner',task.id)).preview));const live=await runtime.get('owner',task.id);assert.equal(live.status,'running');assert.match(live.preview,/^## 已确认\n- \*\*立即\*\*/);}
 finally{gate.resolve();}
 assert.equal((await settled(runtime,task.id)).status,'completed');
});

test('configured bridge repairs one malformed tool response before executing any tool',async t=>{
  const f=await fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{calls++;const body=JSON.parse(options.body);if(calls===2)assert.match(JSON.stringify(body),/previous response had invalid structure/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?{toolCalls:[{name:'read_repository',arguments:{}}]}:calls===2?{toolCalls:[{name:'read_selected_meeting',arguments:{recordId:f.records[0].id}}]}:{result:result(f.records.slice(0,1))})}}]}),{headers:{'content-type':'application/json'}});});
  const runtime=await f.open({env:{LLM_API_KEY:'explicit-test-key',LLM_MODEL:'fixture-http',LLM_API_URL:'https://fixture.invalid/chat/completions',LLM_PROTOCOL:'chat-completions'}}),task=await runtime.request('owner',request(f.records.slice(0,1)));
  assert.equal((await settled(runtime,task.id)).status,'completed');assert.equal(calls,3);
});

test('unchanged minutes-only task polling reuses the frozen source hash',async t=>{
  const f=await fixture(t),p=provider([reads(f.records.slice(0,1)),message(JSON.stringify(result(f.records.slice(0,1))))]),runtime=await f.open(p);
  await f.repo.change(f.records[0].id,record=>{record.minutes.decisions=[{text:'保留人工纪要',evidence:[{segmentId:record.segments[0].id,revision:record.segments[0].revision}]}];});
  const task=await runtime.request('owner',{...request(f.records.slice(0,1)),minutesOnly:true});assert.equal((await settled(runtime,task.id)).status,'completed');
  const original=f.repo.get.bind(f.repo);let sourceReads=0;t.mock.method(f.repo,'get',async id=>{if(id===f.records[0].id)sourceReads++;return original(id);});
  for(let i=0;i<30;i++)await runtime.get('owner',task.id);assert.equal(sourceReads,0);
  await f.repo.change(f.records[0].id,record=>{record.minutesRevision++;});sourceReads=0;assert.equal((await runtime.get('owner',task.id)).stale,true);assert.equal(sourceReads,1);
});


test('an owner does not queue behind another owner running Agent',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),p=provider([async(_context,options)=>{entered.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));return message('aborted',{stopReason:'aborted'});}]),runtime=await f.open(p);
  const first=await runtime.request('owner',request(f.records,'first-owner'));await entered.promise;
  const other=createRecord('other',{title:'另一账户'});other.segments=[{id:'other-segment',revision:1,text:'另一账户的独立讨论',startMs:0,endMs:10}];await f.repo.insert(other);
  p.fake.setResponses([reads([other]),message(JSON.stringify(result([other])))]);
  const independent=await runtime.request('other',request([other],'second-owner'));assert.equal((await settled(runtime,independent.id,'other')).status,'completed');
  assert.equal((await runtime.get('owner',first.id)).status,'running');await runtime.cancel('owner',first.id);assert.equal((await settled(runtime,first.id)).status,'cancelled');
});

test('summary list reads the root index once and transfers details only for the selected task',async t=>{
 const f=await fixture(t),large={...result(f.records),summary:'保留完整复盘内容。'.repeat(800)},p=provider(Array.from({length:12},()=>[reads(f.records),message(JSON.stringify(large))]).flat());
 const open=Harness.open;let snapshots=0;
 Harness.open=async(...args)=>{const h=await open(...args),snapshot=h.snapshot;h.snapshot=(...input)=>{snapshots++;return snapshot.apply(h,input);};return h;};
 t.after(()=>{Harness.open=open;});
 const runtime=await f.open(p),ids=[];
 for(let i=0;i<12;i++){const task=await runtime.request('owner',request(f.records,`list-perf-${i}`));assert.equal((await settled(runtime,task.id)).status,'completed');ids.push(task.id);}
 const full=await runtime.list('owner');snapshots=0;const summaries=await runtime.list('owner',{view:'summary',detailId:ids[0]});
 const before=Buffer.byteLength(JSON.stringify(full)),after=Buffer.byteLength(JSON.stringify(summaries));
 console.info(JSON.stringify({agentList:{tasks:ids.length,snapshots,beforeBytes:before,afterBytes:after}}));
 assert.equal(summaries.filter(task=>task.result).length,1,'only explicitly selected task should include full results');
 assert.deepEqual(summaries.find(task=>task.id===ids[0]).result,large);
 assert.ok(summaries.filter(task=>task.id!==ids[0]).every(task=>task.preview.length<=321));
 assert.ok(snapshots<=ids.length+3,`list repeated root snapshots ${snapshots} times`);
 assert.ok(after<before*.25,'list summary should reduce transferred bytes by at least 75%');
 assert.deepEqual(await runtime.list('other',{view:'summary',detailId:ids[0]}),[]);
 await f.repo.change(f.records[0].id,record=>{record.segments[0].text='另一修订';record.segments[0].revision++;record.transcriptRevision++;});
 assert.ok((await runtime.list('owner',{view:'summary'})).every(task=>task.stale));
});

test('interactive questions survive long waits and reused Skill question IDs require fresh answers',async t=>{
 const f=await fixture(t),p=provider([reads(f.records),message(call('request_user_input',{id:'confirm',question:'选择归档分支？',options:['合并请求','直接提交']}),{stopReason:'toolUse'}),message(call('request_user_input',{id:'confirm',question:'是否附带笔记？',options:['附带','不附带']}),{stopReason:'toolUse'}),message(JSON.stringify(result(f.records)))]);
 const runtime=await f.open(p),task=await runtime.request('owner',request(f.records,'question-reuse'),{jobId:'interactive-fixture',managed:false});
 let state;await waitUntil(async()=>{state=await runtime.get('owner',task.id);return state.interaction?.question==='选择归档分支？';});
 const first=state.interaction.id,now=Date.now;try{Date.now=()=>now()+175*60000;const delayed=await runtime.get('owner',task.id);assert.equal(delayed.interaction.id,first);assert.equal(delayed.status,'running');}finally{Date.now=now;}
 await runtime.respond('owner',task.id,{id:first,answer:'合并请求'});
 await waitUntil(async()=>{state=await runtime.get('owner',task.id);return state.interaction?.question==='是否附带笔记？'||state.status==='completed';});
 assert.equal(state.interaction?.question,'是否附带笔记？','a reused Skill id must not silently reuse the earlier answer');assert.notEqual(state.interaction.id,first);
 await assert.rejects(runtime.respond('owner',task.id,{id:first,answer:'旧问题回复'}),{code:'agent_input_changed'});
 await runtime.respond('owner',task.id,{id:state.interaction.id,answer:'不附带'});assert.equal((await settled(runtime,task.id)).status,'completed');
});

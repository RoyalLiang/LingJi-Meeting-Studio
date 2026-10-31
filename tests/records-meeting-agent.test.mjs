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
  const p=provider(),configured=await f.open(p);await f.repo.change(f.records[0].id,record=>{record.segments[0].text='x'.repeat(60001);});await assert.rejects(configured.request('owner',request(f.records)),{code:'agent_input_too_large'});
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

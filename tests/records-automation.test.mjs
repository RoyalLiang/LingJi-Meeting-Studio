import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecord, requestMinutes, commitMinutes, validateMinutes, addSource, acknowledge, digest, editSegment } from '../packages/records/src/record.mjs';
import { setAutomation, automaticMinutesAt, queueAutomaticMinutes, updateMinutesPreview } from '../packages/records/src/automation.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { saveConfig } from '../services/records/src/config.mjs';
import http from 'node:http';
import { publicRecord } from '../packages/records/src/record.mjs';
const segment = {id:'s1',revision:1,text:'决定周五评审',startMs:0,endMs:1000,speaker:'',sourceId:'text-import'};
const result = {title:'评审',topics:[{title:'评审安排',summary:'确定评审时间',evidence:[{segmentId:'s1',revision:1}]}],sections:[{heading:'决定',items:[{text:'周五评审',evidence:[{segmentId:'s1',revision:1}]}]}],actions:[]};
function record() { const r=createRecord('fixture');r.segments=[{...segment}];r.transcriptRevision=1;r.capture='recording';return r; }
test('automatic minutes debounce live updates, deduplicate and finalize after drain', () => {
 const r=record();setAutomation(r,{enabled:true,intervalSeconds:30},1000);
 assert.equal(automaticMinutesAt(r,1001),31000);assert.equal(queueAutomaticMinutes(r,'fixture',30999),undefined);
 const j=queueAutomaticMinutes(r,'fixture',31000);assert.equal(j.scope,'live');assert.equal(queueAutomaticMinutes(r,'fixture',32000),undefined);
 j.fence='f';r.segments.push({...segment,id:'s2'});r.transcriptRevision++;
 commitMinutes(r,j.id,result,'f');assert.equal(r.liveMinutes.title,'评审');assert.equal(r.minutes,null);
 assert.equal(automaticMinutesAt(r,32000),61000);
 r.capture='sealed';assert.equal(queueAutomaticMinutes(r,'fixture',32000),undefined);
 r.capture='completed';const final=queueAutomaticMinutes(r,'fixture',32000);assert.equal(final.scope,'final');
 final.fence='z';commitMinutes(r,final.id,result,'z');assert.equal(r.minutes.revision,1);assert.equal(automaticMinutesAt(r,33000),Infinity);
});
test('manual corrections, disabled automation and edited evidence fence drafts', () => {
 const r=record();setAutomation(r,{enabled:true},0);r.minutes={edited:true};assert.equal(automaticMinutesAt(r),Infinity);r.minutes=null;
 const j=requestMinutes(r,{scope:'live',automatic:true});j.status='running';j.fence='f';
 updateMinutesPreview(r,j.id,'f','{"title":"会中草稿","sections":[{"heading":"决定","items":[{"text":"周五', {firstTokenMs:100});
 assert.equal(j.preview.at(-1).text,'周五');assert.equal(r.minutes,null);
 r.segments[0].translation='旧翻译';r.segments[0].translationLease=999999;editSegment(r,'s1',{revision:1,text:'改为周六评审'});assert.equal(r.segments[0].translation,undefined);assert.equal(r.segments[0].translationLease,undefined);commitMinutes(r,j.id,result,'f');assert.equal(j.status,'stale');assert.equal(j.preview,undefined);
 const retry=requestMinutes(r,{scope:'live',automatic:true});retry.status='running';retry.fence='x';
 retry.partialMinutes={title:'已校验窗口'};setAutomation(r,{enabled:false});assert.equal(retry.partialMinutes,undefined);updateMinutesPreview(r,retry.id,'x','{"title":"迟到结果"}',{});assert.equal(retry.preview,undefined);
 assert.throws(()=>commitMinutes(r,retry.id,result,'x'),/stale_job/);
});
test('topic citations are validated and local/model jobs have separate identities', () => {
 const r=record();r.capture='completed';assert.notEqual(requestMinutes(r,{mode:'model'}).id,requestMinutes(r,{mode:'extractive'}).id);
 const invalid=structuredClone(result);invalid.topics[0].evidence[0].revision=2;assert.throws(()=>validateMinutes(invalid,r.segments),/invalid_minutes_topics/);
});
test('final minutes retry transient failures with a bounded delay and stop after three attempts', () => {
 const r=record();r.capture='completed';setAutomation(r,{enabled:true},1000);
 const first=queueAutomaticMinutes(r,'fixture',1000);first.status='failed';first.error='llm_timeout';
 assert.equal(automaticMinutesAt(r,1001),16000);
 assert.equal(queueAutomaticMinutes(r,'fixture',15999),undefined);
 const second=queueAutomaticMinutes(r,'fixture',16000);assert.ok(second);second.status='failed';second.error='provider_rate_limited';
 assert.equal(automaticMinutesAt(r,16001),46000);
 const third=queueAutomaticMinutes(r,'fixture',46000);assert.ok(third);third.status='failed';third.error='llm_timeout';
 assert.equal(automaticMinutesAt(r,999999),Infinity);
 setAutomation(r,{enabled:false},999999);assert.equal(automaticMinutesAt(r,999999),Infinity);
});
test('manual final success ends retry scheduling and a fresh manual failure receives its own bounded chain', () => {
 const r=record();r.capture='completed';setAutomation(r,{enabled:true},1000);
 const first=queueAutomaticMinutes(r,'fixture',1000);first.status='failed';first.error='llm_timeout';
 const manual=requestMinutes(r,{mode:'model',modelVersion:'fixture'});manual.fence='manual';
 commitMinutes(r,manual.id,result,'manual');assert.equal(automaticMinutesAt(r,16000),Infinity);
 const completedCount=r.jobs.length,requestedAt=r.autoMinutes.lastRequestedAt;
 assert.equal(queueAutomaticMinutes(r,'fixture',16000),undefined);assert.equal(r.jobs.length,completedCount);assert.equal(r.autoMinutes.lastRequestedAt,requestedAt);

 const retryRecord=record();retryRecord.capture='completed';setAutomation(retryRecord,{enabled:true},1000);
 for(const now of [1000,16000,46000]) {const job=queueAutomaticMinutes(retryRecord,'fixture',now);job.status='failed';job.error='llm_timeout';}
 assert.equal(automaticMinutesAt(retryRecord,99999),Infinity);
 const fresh=requestMinutes(retryRecord,{mode:'model',modelVersion:'fixture',template:'interview'});fresh.status='failed';fresh.error='provider_http_503';fresh.failedAt=100000;
 assert.equal(automaticMinutesAt(retryRecord,100001),115000);
 const second=queueAutomaticMinutes(retryRecord,'fixture',115000);assert.equal(second.template,'interview');assert.equal(second.retryAttempt,2);assert.equal(second.retryOf,fresh.id);
 second.status='failed';second.error='llm_timeout';second.failedAt=115000;
 const third=queueAutomaticMinutes(retryRecord,'fixture',145000);assert.equal(third.retryAttempt,3);third.status='failed';third.error='llm_timeout';third.failedAt=145000;
 assert.equal(automaticMinutesAt(retryRecord,999999),Infinity);
});
test('automatic retries preserve human minutes and do not retry invalid configuration or unvalidated output', () => {
 for(const error of ['provider_unauthorized','llm_endpoint_not_api','invalid_minutes_schema','minutes_intermediate_too_large']) {
  const r=record();r.capture='completed';setAutomation(r,{enabled:true},1000);
  const job=queueAutomaticMinutes(r,'fixture',1000);job.status='failed';job.error=error;
  assert.equal(automaticMinutesAt(r,999999),Infinity,error);
 }
 const r=record();r.capture='completed';setAutomation(r,{enabled:true},1000);
 const job=queueAutomaticMinutes(r,'fixture',1000);job.status='failed';job.error='llm_connection_failed';r.minutes={edited:true};
 assert.equal(automaticMinutesAt(r,999999),Infinity);
 r.minutes=null;job.status='cancelled';assert.equal(automaticMinutesAt(r,999999),Infinity);
 job.status='failed';r.minutesRevision++;assert.equal(automaticMinutesAt(r,999999),Infinity);
 r.minutesRevision--;r.deleted=true;assert.equal(automaticMinutesAt(r,999999),Infinity);
});
test('worker persists a transient final failure, retries after restart and commits validated AI content once', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-final-retry-'));let repo=await createRepository({root,databaseUrl:''});
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;let calls=0;
 const r=record();r.capture='completed';setAutomation(r,{enabled:true},now);await repo.insert(r);
 const providers={minutes:async()=>{calls++;if(calls===1)throw Object.assign(new Error('synthetic deadline'),{code:'llm_timeout'});return result;}};
 try {
  await saveConfig(root,{LLM_API_URL:'http://fixture.invalid/responses',LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-model'},{});
  await runCycle(repo,providers,{lane:'minutes'});
  let saved=await repo.get(r.id);assert.equal(calls,1);assert.equal(saved.jobs.at(-1).status,'failed');assert.equal(saved.minutes,null);
  assert.equal(automaticMinutesAt(saved,now),now+15000);assert.ok(saved.nextWorkAt<=now+15000);
  await repo.close();repo=await createRepository({root,databaseUrl:''});now+=15001;
  await runCycle(repo,providers,{lane:'minutes'});saved=await repo.get(r.id);
  assert.equal(calls,2);assert.equal(saved.jobs.at(-1).status,'completed');assert.equal(saved.minutes.title,'评审');
  assert.deepEqual(saved.minutes.sections,result.sections);assert.equal(saved.title,'评审');
  assert.equal(saved.minutes.evidenceSnapshot[0].id,'s1');assert.equal(saved.minutes.evidenceSnapshot[0].revision,1);
  await runCycle(repo,providers,{lane:'minutes'});assert.equal(calls,2);
 } finally {Date.now=originalNow;await repo.close();await rm(root,{recursive:true,force:true});}
});
test('real localhost provider HTTP and incomplete SSE errors follow bounded chains, then a new manual model run can recover', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-final-http-retry-')),repo=await createRepository({root,databaseUrl:''});
 const originalNow=Date.now;let now=originalNow(),calls=0;Date.now=()=>now;
 const server=http.createServer(async(req,res)=>{
  for await(const chunk of req) void chunk;
  calls++;
  if(calls===1 || calls===2 || calls===4) {now+=2000;res.writeHead(calls===2?429:503,{'content-type':'application/json'});res.end('{"error":{"code":"synthetic_service_error"}}');return;}
  if(calls===3) {res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(result)})}\n\n`);return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'completed',output_text:JSON.stringify(result)}));
 });
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await saveConfig(root,{LLM_API_URL:`http://127.0.0.1:${server.address().port}/responses`,LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-model',LLM_PROTOCOL:'responses'},{});
  const r=record();r.capture='completed';setAutomation(r,{enabled:true},now);await repo.insert(r);
  for(const [index,error] of ['provider_http_503','provider_rate_limited','llm_stream_incomplete'].entries()) {
   await runCycle(repo,{}, {lane:'minutes'});const saved=await repo.get(r.id);
   assert.equal(saved.jobs.at(-1).error,error);assert.equal(saved.jobs.at(-1).retryAttempt,index+1);
   if(index<2){assert.equal(automaticMinutesAt(saved,now),now+15000*2**index);now+=15000*2**index;}
  }
  assert.equal(calls,3);now+=60000;await runCycle(repo,{}, {lane:'minutes'});assert.equal(calls,3);
  await saveConfig(root,{LLM_MODEL:'fixture-model-v2'},{});
  await repo.change(r.id,value=>requestMinutes(value,{mode:'model',modelVersion:'fixture-model-v2',template:'interview'}));
  await runCycle(repo,{}, {lane:'minutes'});assert.equal(calls,4);const failed=await repo.get(r.id);
  assert.equal(automaticMinutesAt(failed,now),now+15000);now+=15000;
  await runCycle(repo,{}, {lane:'minutes'});const saved=await repo.get(r.id);
  assert.equal(calls,5);assert.equal(saved.minutes.title,'评审');assert.equal(saved.jobs.at(-1).retryAttempt,2);
  assert.equal(saved.jobs.at(-1).template,'interview');assert.equal(saved.jobs.at(-1).modelVersion,'fixture-model-v2');
  assert.equal(automaticMinutesAt(saved,now),Infinity);
 } finally {Date.now=originalNow;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await repo.close();await rm(root,{recursive:true,force:true});}
});
for(const pipelineOff of [false,true])for(const humanEdit of [false,true])test(`live provider usage reaches public projections before completion, pipeline ${pipelineOff?'off':'on'}, human protection ${humanEdit}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-live-usage-')),repo=await createRepository({root,databaseUrl:''});
 const previous=process.env.RECORD_MINUTES_PIPELINE_ENABLED;process.env.RECORD_MINUTES_PIPELINE_ENABLED=String(!pipelineOff);
 let release,started;const blocked=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
 const server=http.createServer(async(req,res)=>{
  for await(const chunk of req)void chunk;
  res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  const usage={prompt_tokens:5,completion_tokens:2,total_tokens:7};
  res.write(`data: ${JSON.stringify({usage})}\n\ndata: ${JSON.stringify({usage})}\n\n`);started();await blocked;
  res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({...result,tokens:999999,usageTokens:999999,tokenUsage:{totalTokens:999999}})},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
 });
 let work;
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await saveConfig(root,{LLM_API_URL:`http://127.0.0.1:${server.address().port}/chat/completions`,LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-model',LLM_PROTOCOL:'chat-completions'},{});
  const r=record();r.capture='completed';requestMinutes(r,{modelVersion:'fixture-model'});await repo.insert(r);const initial=publicRecord(r);
  work=runCycle(repo,{}, {lane:'minutes'});await ready;
  let streaming;
  for(let index=0;index<100;index++){streaming=await repo.get(r.id);if(streaming.usage.llmTokens===7)break;await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(streaming.usage.llmTokens,7);assert.equal(streaming.minutes,null);assert.equal(streaming.jobs[0].status,'running');
  assert.equal(streaming.usage.minutesMeter.requests,1);assert.equal(streaming.usage.minutesMeter.reportedRequests,1);
  const visible=publicRecord(streaming);assert.equal(visible.jobs[0].usageCalls,undefined);
  const events=await repo.eventsAfter(r.id,initial.cursor),updates=events.events.filter(event=>event.type==='minutes.usage');
  const latest=updates.at(-1);assert.equal(latest.delta.set.usage.llmTokens,7);assert.equal(latest.delta.set.usage.minutesMeter.inputTokens,5);
  assert.equal(JSON.stringify(latest.delta).includes('usageCalls'),false);
  if(humanEdit)await repo.change(r.id,value=>{value.minutesRevision++;value.minutes={title:'人工保留内容',edited:true};});
  release();await work;const saved=await repo.get(r.id);
  assert.equal(saved.usage.llmTokens,7);assert.equal(saved.usage.minutesMeter.totalTokensRequests,1);
  assert.equal(saved.minutes.title,humanEdit?'人工保留内容':'评审');assert.equal(saved.jobs[0].status,humanEdit?'stale':'completed');
 } finally {
  release();await work;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await repo.close();await rm(root,{recursive:true,force:true});
  if(previous===undefined)delete process.env.RECORD_MINUTES_PIPELINE_ENABLED;else process.env.RECORD_MINUTES_PIPELINE_ENABLED=previous;
 }
});
test('audio progresses while a model job streams, without publishing an unvalidated draft', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-live-'));const repo=await createRepository({root});
 let release, started; const blocked=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
 const r=record(), source=addSource(r,{kind:'microphone'}), bytes=Buffer.alloc(3200);
 const object=await repo.putAudio(r.id,bytes);acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(bytes),...object});
 requestMinutes(r,{scope:'live'});await repo.insert(r);
 try {
  const pending=runCycle(repo,{minutes:async (_job,_config,{onDelta})=>{await onDelta('{"title":"流式预览"',{firstTokenMs:4,elapsedMs:5});started();await blocked;return result;}},{lane:'minutes'});
  await ready;assert.equal((await repo.get(r.id)).jobs[0].preview[0].text,'流式预览');assert.equal((await repo.get(r.id)).liveMinutes,null);
  await runCycle(repo,{transcribe:async()=> '后续讨论'},{lane:'audio'});assert.equal((await repo.get(r.id)).segments.length,2);
  release();await pending;assert.equal((await repo.get(r.id)).liveMinutes.title,'评审');
 } finally {release();await repo.close();await rm(root,{recursive:true,force:true});}
});

test('translation waiting never delays audio transcript persistence', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-translation-'));const repo=await createRepository({root});
 let release,started;const blocked=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
 const r=record();r.translationTarget='en';const source=addSource(r,{kind:'microphone'}),bytes=Buffer.alloc(3200);
 const object=await repo.putAudio(r.id,bytes);acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(bytes),...object});await repo.insert(r);
 try {
  const pending=runCycle(repo,{translate:async()=>{started();await blocked;return 'Synthetic translation';}},{lane:'translation'});
  await ready;await runCycle(repo,{transcribe:async()=> '新的片段'},{lane:'audio'});assert.equal((await repo.get(r.id)).segments.length,2);
  release();await pending;assert.equal((await repo.get(r.id)).segments[0].translation,'Synthetic translation');
 } finally {release();await repo.close();await rm(root,{recursive:true,force:true});}
});


test('a final minutes job keeps its lease while a longer model request is in flight', async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-final-lease-')),repo=await createRepository({root,databaseUrl:''});
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 let release,started,pending,calls=0;const blocked=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
 const r=record();r.capture='completed';requestMinutes(r);await repo.insert(r);
 try{
  pending=runCycle(repo,{minutes:async()=>{calls++;started();await blocked;return result;}},{lane:'minutes'});
  await ready;
  const fence=(await repo.get(r.id)).jobs[0].fence;
  now+=190000;
  await runCycle(repo,{minutes:async()=>{calls++;return result;}},{lane:'minutes'});
  assert.equal(calls,1,'another worker reclaimed the final job before its model deadline');
  assert.equal((await repo.get(r.id)).jobs[0].fence,fence);
  release();await pending;assert.equal((await repo.get(r.id)).jobs[0].status,'completed');
 }finally{release();await pending;Date.now=originalNow;await repo.close();await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecord, requestMinutes, commitMinutes, validateMinutes, addSource, acknowledge, digest, editSegment, pause, seal, commitTranscript } from '../packages/records/src/record.mjs';
import { setAutomation, automaticMinutesAt, queueAutomaticMinutes, updateMinutesPreview } from '../packages/records/src/automation.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { saveConfig } from '../services/records/src/config.mjs';
import http from 'node:http';
import { publicRecord } from '../packages/records/src/record.mjs';
const segment = {id:'s1',revision:1,text:'决定周五评审',startMs:0,endMs:1000,speaker:'',sourceId:'text-import'};
const result = {title:'评审',topics:[{title:'评审安排',summary:'确定评审时间',evidence:[{segmentId:'s1',revision:1}]}],sections:[{heading:'决定',items:[{text:'周五评审',evidence:[{segmentId:'s1',revision:1}]}]}],actions:[]};
function record() { const r=createRecord('fixture');r.segments=[{...segment}];r.transcriptRevision=1;r.capture='recording';return r; }

test('a slow summary continues after stop and the final worker includes the drained audio tail',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-summary-drain-')),repo=await createRepository({root,databaseUrl:''});
 let release,work,ready;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{ready=resolve;});
 try{
  await saveConfig(root,{LLM_API_URL:'http://fixture.invalid/chat/completions',LLM_API_KEY:'fixture',LLM_MODEL:'fixture-model'},{});
  const r=record(),source=addSource(r,{kind:'microphone'}),bytes=Buffer.alloc(3200);
  acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(bytes),object:'fixture-tail'});
  setAutomation(r,{enabled:true},Date.now()-31000);await repo.insert(r);
  const scopes=[];
  const providers={minutes:async job=>{
   scopes.push(job.scope);
   if(job.scope==='live'){ready();await gate;}
   return {title:job.scope==='live'?'会中完整总结':'最终含尾段总结',sections:[{heading:'内容',items:job.snapshot.filter(s=>!s.contextOnly).map(s=>({text:s.text,evidence:[{segmentId:s.id,revision:s.revision}]}))}],actions:[]};
  }};
  work=runCycle(repo,providers,{lane:'minutes'});await started;
  await repo.change(r.id,value=>seal(value,[{sourceId:source.id,epoch:source.epoch,lastSequence:0}]));
  assert.equal((await repo.get(r.id)).capture,'sealed');
  await repo.change(r.id,value=>commitTranscript(value,value.chunks[0].key,'尾段：评审改为周一',value.generation));
  await runCycle(repo,providers,{lane:'minutes'});
  assert.deepEqual(scopes,['live']);assert.equal((await repo.get(r.id)).jobs[0].status,'running');
  release();await work;
  assert.equal((await repo.get(r.id)).liveMinutes.title,'会中完整总结');
  await runCycle(repo,providers,{lane:'minutes'});
  const saved=await repo.get(r.id);
  assert.deepEqual(scopes,['live','final']);assert.equal(saved.minutes.transcriptRevision,saved.transcriptRevision);
  assert.ok(saved.minutes.sections.flatMap(section=>section.items).some(item=>item.text.includes('尾段：评审改为周一')));
  assert.ok(saved.jobs.every(job=>job.status==='completed'));assert.equal(saved.title,'最终含尾段总结');
 }finally{release();await work;await repo.close();await rm(root,{recursive:true,force:true});}
});
test('an exhausted interrupted minutes job reaches failure instead of staying running forever',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-expired-minutes-')),repo=await createRepository({root,databaseUrl:''});
 try{
  for(const [status,lease] of [['running',Date.now()-1],['running',undefined],['queued',undefined]]){
   const r=record();r.capture='completed';
   const job=requestMinutes(r,{scope:'final',modelVersion:'fixture'});
   Object.assign(job,{status,lease,attempts:3,fence:'obsolete-worker',preview:[{kind:'item',text:'待核验'}],partialMinutes:result});
   await repo.insert(r);
   await runCycle(repo,{minutes:async()=>{assert.fail('attempt budget must stay bounded');}},{lane:'minutes'});
   const saved=await repo.get(r.id),failed=saved.jobs.find(j=>j.id===job.id);
   assert.equal(failed.status,'failed');assert.equal(failed.error,'minutes_request_failed');
   assert.equal(failed.fence,null);assert.deepEqual(failed.snapshot,[]);assert.equal(failed.preview,undefined);assert.equal(failed.partialMinutes,undefined);
  }
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

test('a post-stop timeout retains validated windows and refuses stale or manually protected drafts',async()=>{
 for(const protection of ['none','notes','transcript','manual','recording']){
  const root=await mkdtemp(join(tmpdir(),'tts-summary-timeout-')),repo=await createRepository({root,databaseUrl:''});
  let release,work,ready,calls=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{ready=resolve;});
  try{
   const r=record();r.segments=[{...segment,id:'early',startMs:0,endMs:1000},{...segment,id:'late',startMs:400000,endMs:401000}];
   requestMinutes(r,{scope:'live',mode:'model'});await repo.insert(r);
   work=runCycle(repo,{minutes:async job=>{
    if(++calls===2){ready();await gate;throw Object.assign(new Error('timeout'),{code:'llm_timeout'});}
    const source=job.snapshot.find(s=>!s.contextOnly),evidence=[{segmentId:source.id,revision:source.revision}];
    return {title:'保留已校验部分',sections:[{heading:'已校验',items:[{text:'第一窗内容',evidence}]}],highlights:[{text:'第一窗重点',evidence}],actions:[]};
   }},{lane:'minutes'});
   await started;
   for(let count=0;count<100 && !(await repo.get(r.id)).jobs[0].partialMinutes;count++)await new Promise(resolve=>setTimeout(resolve,2));
   assert.equal((await repo.get(r.id)).jobs[0].partialMinutes.highlights[0].text,'第一窗重点');
   await repo.change(r.id,value=>{
    if(protection!=='recording')seal(value,[]);
    if(protection==='notes')value.notesRevision++;
    if(protection==='transcript')value.segments[0].revision++;
    if(protection==='manual')value.minutes={edited:true};
   });
   release();await work;
   const saved=await repo.get(r.id);
   assert.equal(saved.jobs[0].status,'failed');assert.equal(saved.jobs[0].error,'llm_timeout');
   if(protection==='none'){
    assert.equal(saved.liveMinutes.highlights[0].text,'第一窗重点');
    assert.equal(saved.liveMinutes.template,undefined,'a partial cannot mark unfinished transcript windows as covered');
    assert.ok(requestMinutes(saved,{scope:'live'}).snapshot.every(source=>source.contextOnly===false));
   }else assert.equal(saved.liveMinutes,null);
  }finally{release();await work;await repo.close();await rm(root,{recursive:true,force:true});}
 }
});
test('live worker exposes first-window draft while other windows wait and keeps it through transcript appends',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-live-visible-')),repo=await createRepository({root,databaseUrl:''});let release,work,started=0,ready;
 const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{ready=resolve;});
 try{
  await saveConfig(root,{LLM_API_URL:'http://fixture.invalid/chat/completions',LLM_API_KEY:'fixture',LLM_MODEL:'fixture-model'},{});
  const r=record();r.segments=Array.from({length:12},(_,i)=>({...segment,id:'s'+i,startMs:i*1000,endMs:(i+1)*1000,text:'核对接口依赖与发布准备。'.repeat(100)}));
  setAutomation(r,{enabled:true,intervalSeconds:120},Date.now()-31000);await repo.insert(r);
  work=runCycle(repo,{minutes:async(job,env,options)=>{
   if(job.stage==='synthesis')return {title:'汇总',sections:[{heading:'讨论',items:job.summaries.flatMap(s=>s.sections.flatMap(s=>s.items))}],actions:[]};
   const source=job.snapshot.find(s=>!s.contextOnly);
   await options.onDelta?.(JSON.stringify({title:'首窗实时草稿'+source.id,sections:[{heading:'当前讨论',items:[{text:'先核对接口依赖'+source.id}]}]}),{firstTokenMs:5});
   if(++started===2)ready();await gate;
   return {title:'纪要',sections:[{heading:'讨论',items:[{text:'核对接口依赖',evidence:[{segmentId:source.id,revision:source.revision}]}]}],actions:[]};
  }},{lane:'minutes'});
  await waiting;let current;
  for(let i=0;i<100;i++){current=await repo.get(r.id);if(current.jobs.at(-1).preview?.length)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(current.liveMinutes,null);assert.equal(current.jobs.at(-1).status,'running');assert.ok(current.jobs.at(-1).preview.some(b=>b.text.startsWith('先核对接口依赖')));assert.equal(current.jobs.at(-1).preview.filter(b=>b.kind==='text').length,1,'concurrent windows must not interleave preview JSON');
  await repo.change(r.id,value=>{value.segments.push({...segment,id:'later'});value.transcriptRevision++;});
  release();await work;const saved=await repo.get(r.id);assert.equal(saved.jobs.at(-1).status,'completed');assert.ok(saved.liveMinutes.sections.length>0);assert.ok(saved.liveMinutes.transcriptRevision<saved.transcriptRevision);
 }finally{release();await work;await repo.close();await rm(root,{recursive:true,force:true});}
});

test('first live minutes starts within thirty seconds while later refreshes keep the configured interval',()=>{
 const r=record();setAutomation(r,{enabled:true,intervalSeconds:120},1000);
 assert.equal(automaticMinutesAt(r,1001),31000);assert.equal(queueAutomaticMinutes(r,'fixture',30999),undefined);
 const job=queueAutomaticMinutes(r,'fixture',31000);assert.ok(job);job.status='completed';r.transcriptRevision++;
 assert.equal(automaticMinutesAt(r,31001),151000);assert.equal(r.autoMinutes.intervalSeconds,120);
});
test('automatic minutes debounce live updates, deduplicate and finalize after drain', () => {
 const r=record();setAutomation(r,{enabled:true,intervalSeconds:30},1000);
 assert.equal(automaticMinutesAt(r,1001),31000);assert.equal(queueAutomaticMinutes(r,'fixture',30999),undefined);
 const j=queueAutomaticMinutes(r,'fixture',31000);assert.equal(j.scope,'live');assert.equal(queueAutomaticMinutes(r,'fixture',32000),undefined);
 j.fence='f';r.segments.push({...segment,id:'s2'});r.transcriptRevision++;
 commitMinutes(r,j.id,result,'f');assert.equal(r.liveMinutes.title,'评审');assert.equal(r.minutes,null);
 assert.equal(automaticMinutesAt(r,32000),61000);
 r.capture='sealed';const tail=queueAutomaticMinutes(r,'fixture',32000);assert.equal(tail.scope,'live');
 tail.fence='t';const tailResult=JSON.parse(JSON.stringify(result).replaceAll('s1','s2'));commitMinutes(r,tail.id,tailResult,'t');
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
test('automatic retries preserve human minutes and do not retry invalid configuration or unsafe evidence', () => {
 for(const error of ['provider_unauthorized','llm_endpoint_not_api','invalid_minutes_evidence','minutes_intermediate_too_large']) {
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
  res.write(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({...result,tokens:999999,usageTokens:999999,tokenUsage:{totalTokens:999999}})},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
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


for (const capture of ['paused','completed']) test(`a ${capture} completion job keeps its lease while the longer model request is in flight`, async () => {
 const root=await mkdtemp(join(tmpdir(),'tts-final-lease-')),repo=await createRepository({root,databaseUrl:''});
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 let release,started,pending,calls=0;const blocked=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
 const r=record();r.capture=capture;if(capture==='completed')requestMinutes(r);else{setAutomation(r,{enabled:true},now);queueAutomaticMinutes(r,'fixture',now);}await repo.insert(r);
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

test('final minutes automatically recover a malformed model response with bounded retries and edit protection', () => {
  for (const error of ['invalid_minutes_schema','invalid_llm_response']) {
    const r=record(); r.capture='completed'; setAutomation(r,{enabled:true},1000);
    const first=queueAutomaticMinutes(r,'fixture',1000);
    Object.assign(first,{status:'failed',error,failedAt:1000});
    assert.equal(automaticMinutesAt(r,1001),16000, `${error} must leave a bounded automatic recovery path`);
    const second=queueAutomaticMinutes(r,'fixture',16000);
    assert.equal(second.retryAttempt,2);
    Object.assign(second,{status:'failed',error,failedAt:16000});
    const third=queueAutomaticMinutes(r,'fixture',46000);
    assert.equal(third.retryAttempt,3);
    Object.assign(third,{status:'failed',error,failedAt:46000});
    assert.equal(automaticMinutesAt(r,999999),Infinity,'malformed output must not loop or create unlimited paid requests');
    r.minutes={edited:true};
    assert.equal(automaticMinutesAt(r,999999),Infinity);
  }
});

test('pausing automatically catches up saved content and retries a failed live summary without ending the meeting', () => {
  const r=record(); r.capture='paused'; setAutomation(r,{enabled:true},1000);
  const failed=requestMinutes(r,{mode:'model',scope:'live',automatic:true,modelVersion:'fixture'});
  Object.assign(failed,{status:'failed',error:'invalid_minutes_schema',failedAt:1000,retryAttempt:1});
  Object.assign(r.autoMinutes,{lastRevision:r.transcriptRevision,lastScope:'live',lastRequestedAt:1000});
  assert.equal(automaticMinutesAt(r,1001),16000,'pause must not abandon a failed final live batch');
  const retry=queueAutomaticMinutes(r,'fixture',16000);
  assert.equal(retry.scope,'live');assert.equal(retry.retryAttempt,2);
  assert.equal(r.capture,'paused','catch-up must preserve resumable capture');
  retry.status='running';retry.fence='pause-retry';
  commitMinutes(r,retry.id,result,'pause-retry');
  assert.ok(r.liveMinutes);assert.equal(r.minutes,null);
  assert.equal(automaticMinutesAt(r,17000),Infinity,'an unchanged successful pause checkpoint must not repeat requests');
});

for (const capture of ['paused','completed']) test(`worker recovers malformed ${capture} minutes after restart and only commits validated content`, async () => {
  const root=await mkdtemp(join(tmpdir(),'tts-checkpoint-recovery-'));let repo=await createRepository({root,databaseUrl:''});
  const originalNow=Date.now;let now=originalNow(),calls=0;Date.now=()=>now;
  const r=record();r.capture=capture;setAutomation(r,{enabled:true},now);await repo.insert(r);
  const providers={minutes:async()=>++calls===1?{title:'incomplete model response'}:result};
  try {
    await saveConfig(root,{LLM_API_URL:'http://fixture.invalid/responses',LLM_API_KEY:'fixture-key',LLM_MODEL:'fixture-model'},{});
    await runCycle(repo,providers,{lane:'minutes'});
    let saved=await repo.get(r.id);
    assert.equal(saved.jobs.at(-1).status,'failed');assert.equal(saved.jobs.at(-1).error,'invalid_minutes_schema');
    assert.equal(saved.minutes,null);assert.ok(!saved.liveMinutes,'malformed content must never become a saved summary');
    assert.equal(automaticMinutesAt(saved,now),now+15000);
    await repo.close();repo=await createRepository({root,databaseUrl:''});now+=15001;
    await runCycle(repo,providers,{lane:'minutes'});saved=await repo.get(r.id);
    assert.equal(saved.capture,capture);assert.equal(saved.jobs.at(-1).status,'completed');assert.equal(saved.jobs.at(-1).retryAttempt,2);
    const document=capture==='paused'?saved.liveMinutes:saved.minutes;
    assert.equal(document.title,'评审');assert.equal(document.transcriptRevision,saved.transcriptRevision);
    assert.deepEqual(document.sections,result.sections);
    await runCycle(repo,providers,{lane:'minutes'});assert.equal(calls,2,'a recovered stable checkpoint must not regenerate again');
  } finally {Date.now=originalNow;await repo.close();await rm(root,{recursive:true,force:true});}
});

test('paused catch-up waits for the stop manifest tail to be durably acknowledged and transcribed', () => {
  const r=record(),source=addSource(r,{kind:'microphone'}),bytes=Buffer.alloc(32000);
  const packet=sequence=>({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes),object:`synthetic-${sequence}`});
  acknowledge(r,packet(0));commitTranscript(r,r.chunks[0].key,'已录内容',r.generation);
  pause(r,[{sourceId:source.id,epoch:source.epoch,lastSequence:1}]);setAutomation(r,{enabled:true},1000);
  assert.ok(r.chunks.every(chunk=>chunk.state==='done'));
  assert.equal(source.watermark,0);assert.equal(source.lastSequence,1);
  assert.equal(automaticMinutesAt(r,2000),Infinity,'a local tail absent from the durable server chunks must block catch-up');
  acknowledge(r,packet(1));
  assert.equal(automaticMinutesAt(r,2000),Infinity,'durable audio still waits for transcript commit');
  commitTranscript(r,r.chunks[1].key,'补传尾音',r.generation);
  const checkpoint=queueAutomaticMinutes(r,'fixture',2000);
  assert.equal(checkpoint.scope,'live');assert.equal(checkpoint.pausedCheckpoint,true);assert.equal(r.capture,'paused');
});

test('default minutes interval is ninety seconds and explicit choices survive', () => {
  const record = createRecord('interval-owner');
  assert.equal(record.autoMinutes.intervalSeconds, 90);
  setAutomation(record, {enabled:true,intervalSeconds:15});
  setAutomation(record, {enabled:true});
  assert.equal(record.autoMinutes.intervalSeconds, 15);
  delete record.autoMinutes.intervalSeconds;
  setAutomation(record, {enabled:true});
  assert.equal(record.autoMinutes.intervalSeconds, 90);
});


test('received minutes text is flushed while the model pauses, and a cancelled job rejects late flushes',async()=>{
 for(const cancel of [false,true]){
  const root=await mkdtemp(join(tmpdir(),'tts-preview-tail-')),repo=await createRepository({root,databaseUrl:''});let release,ready,work;
  const gate=new Promise(resolve=>{release=resolve;}),received=new Promise(resolve=>{ready=resolve;});
  try{
   const r=record();requestMinutes(r,{scope:'live',modelVersion:'fixture'});await repo.insert(r);
   work=runCycle(repo,{minutes:async(job,env,options)=>{
    const text=JSON.stringify(result),cut=text.indexOf(':')+1;
    await options.onDelta(text.slice(0,cut),{firstTokenMs:1});
    await options.onDelta(text.slice(cut),{firstTokenMs:1});ready();await gate;return result;
   }},{lane:'minutes'});
   await received;
   if(cancel)await repo.change(r.id,value=>{const job=value.jobs.at(-1);job.status='cancelled';job.fence=null;delete job.preview;});
   await new Promise(resolve=>setTimeout(resolve,1150));
   const saved=await repo.get(r.id),job=saved.jobs.at(-1);
   if(cancel){assert.equal(job.preview,undefined);assert.equal(job.status,'cancelled');}
   else{assert.equal(job.status,'running');assert.ok(job.preview.some(block=>block.text==='周五评审'),'received body must appear before the model completes');assert.equal(saved.liveMinutes,null);}
   release();await work;
   assert.equal((await repo.get(r.id)).jobs.at(-1).status,cancel?'cancelled':'completed');
  }finally{release();await work;await repo.close();await rm(root,{recursive:true,force:true});}
 }
});

test('slow draft persistence never blocks reading the minutes stream and final commit drains it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-preview-isolated-')),repo=await createRepository({root,databaseUrl:''});
 let releaseWrite,releaseModel,writing,advanced,work,held=false;
 const writeGate=new Promise(r=>{releaseWrite=r;}),modelGate=new Promise(r=>{releaseModel=r;});
 const blocked=new Promise(r=>{writing=r;}),readAhead=new Promise(r=>{advanced=r;});
 const slow=Object.create(repo);
 slow.change=async(id,mutate,options)=>{
   let previewChanged=false;
   const response=await repo.change(id,value=>{
     const before=JSON.stringify(value.jobs.at(-1)?.preview),result=mutate(value);
     previewChanged=JSON.stringify(value.jobs.at(-1)?.preview)!==before;
     return result;
   },options);
   if(!held&&previewChanged){held=true;writing();await writeGate;}
   return response;
 };
 try{
   const r=record();requestMinutes(r,{scope:'live',modelVersion:'fixture'});await repo.insert(r);
   work=runCycle(slow,{minutes:async(job,env,options)=>{await options.onDelta(JSON.stringify(result),{firstTokenMs:1});advanced();await modelGate;return result;}},{lane:'minutes'});
   await blocked;
   assert.equal(await Promise.race([readAhead.then(()=>true),new Promise(r=>setTimeout(()=>r(false),50))]),true,'preview storage must not backpressure provider output');
 }finally{releaseWrite();releaseModel();if(work)await work;await repo.close();await rm(root,{recursive:true,force:true});}
});


test('new meeting without accepted speech never queues automatic minutes across repeated recovery polls',()=>{
 const r=createRecord('fixture');setAutomation(r,{enabled:true},1000);
 for(const capture of ['idle','recording','paused','completed']){
  r.capture=capture;
  for(const now of [1000,31000,61000,3600000])assert.equal(queueAutomaticMinutes(r,'fixture',now),undefined);
 }
 assert.equal(r.jobs.length,0);
});


test('invalid topic output retries after an interval change without bypassing the retry cap', () => {
  const r=record();setAutomation(r,{enabled:true,intervalSeconds:30},1000);
  r.jobs=[{id:'failed-topic',status:'failed',mode:'model',scope:'live',error:'invalid_minutes_topics',transcriptRevision:r.transcriptRevision,notesRevision:r.notesRevision,baseMinutesRevision:r.minutesRevision,retryAttempt:1,failedAt:2000}];
  r.autoMinutes={...r.autoMinutes,lastRevision:r.transcriptRevision,lastScope:'live',lastRequestedAt:1000};
  setAutomation(r,{enabled:true,intervalSeconds:120},3000);
  assert.equal(automaticMinutesAt(r,3000),17000);
  r.jobs[0].retryAttempt=3;assert.equal(automaticMinutesAt(r,3000),Infinity);
});


test('ninety-second automation is accepted while explicit two-minute meetings remain unchanged',()=>{
 const r=createRecord('interval90');setAutomation(r,{enabled:true,intervalSeconds:90});assert.equal(r.autoMinutes.intervalSeconds,90);
 setAutomation(r,{enabled:true,intervalSeconds:120});setAutomation(r,{enabled:true});assert.equal(r.autoMinutes.intervalSeconds,120);
});

test('sealing requests a fresh tail checkpoint immediately instead of waiting for the live interval',()=>{
 const now=Date.now(),r=record(),source=addSource(r,{kind:'microphone'}),bytes=Buffer.alloc(3200);
 acknowledge(r,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:1600,sampleRate:16000,digest:digest(bytes),object:'tail'});
 setAutomation(r,{enabled:true,intervalSeconds:120},now-120000);
 Object.assign(r.autoMinutes,{lastRequestedAt:now-1000,lastRevision:1,lastScope:'live'});
 r.segments.push({...segment,id:'s2',text:'末尾确认评测口径',startMs:1000,endMs:2000});r.transcriptRevision=2;
 seal(r,[{sourceId:source.id,epoch:source.epoch,lastSequence:0}]);
 assert.equal(r.capture,'sealed');
 assert.equal(automaticMinutesAt(r,now),now,'ending bypasses the normal live refresh delay');
 assert.equal(queueAutomaticMinutes(r,'fixture-model',now)?.scope,'live');
});

test('the minutes lane prioritizes an ended meeting ahead of another live refresh',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-finish-priority-')),repo=await createRepository({root,databaseUrl:''});
 const previous=process.env.RECORD_WORKER_CONCURRENCY;process.env.RECORD_WORKER_CONCURRENCY='1';
 try{
  const live=record(),ended=record();ended.capture='completed';
  requestMinutes(live,{scope:'live'});requestMinutes(ended,{scope:'final'});await repo.insert(live);await repo.insert(ended);
  repo.listWork=async()=>[await repo.get(live.id),await repo.get(ended.id)];
  const scopes=[];
  await runCycle(repo,{minutes:async job=>{scopes.push(job.scope);return structuredClone(result);}},{lane:'minutes'});
  assert.deepEqual(scopes,['final','live']);
  assert.equal((await repo.get(ended.id)).jobs[0].status,'completed');
 }finally{if(previous===undefined)delete process.env.RECORD_WORKER_CONCURRENCY;else process.env.RECORD_WORKER_CONCURRENCY=previous;await repo.close();await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,requestMinutes,commitMinutes,validateMinutes,publicRecord,emit} from '../packages/records/src/record.mjs';
import {queueAutomaticMinutes} from '../packages/records/src/automation.mjs';
import {buildMinutesManifest,runMinutesPipeline} from '../services/records/src/minutes-pipeline.mjs';
const config={LLM_MODEL:'fixture-model',LLM_API_URL:'http://fixture.invalid'};
async function fixture(count=100){
  const root=await mkdtemp(join(tmpdir(),'minutes-pipeline-')),repo=await createRepository({root});
  const record=createRecord('owner',{title:'Long transcript',language:'zh'});record.capture='completed';record.transcription='completed';record.transcriptRevision=1;
  record.segments=Array.from({length:count},(_,i)=>({id:`s-${i}`,revision:1,sourceId:'mic',speakerId:'speaker-1',speaker:'发言人1',startMs:i*1000,endMs:(i+1)*1000,text:'x'.repeat(2200)+(i===0?' FACT:早期决定':i===50?' FACT:中期风险':i===99?' FACT:晚期撤回上线承诺':'')}));await repo.insert(record);
  return{repo,record,async claim(){let claim;await repo.change(record.id,r=>{const job=requestMinutes(r,{scope:'final',modelVersion:'fixture-model'});job.status='running';job.fence=`f-${job.id}`;job.lease=Date.now()+300000;claim=structuredClone(job);});return claim;},async close(){await repo.close();await rm(root,{recursive:true,force:true});}};
}
function summarize(job){
  assert.ok(JSON.stringify({transcript:job.snapshot,notes:job.notes,summaries:job.summaries}).length<180000,'provider request budget');
  const items=job.summaries ? job.summaries.flatMap(result=>result.sections.flatMap(section=>section.items)).filter(item=>item.text.includes('FACT:')) : job.snapshot.filter(s=>s.text.includes('FACT:')).map(s=>({text:s.text.slice(s.text.indexOf('FACT:')),evidence:[{segmentId:s.id,revision:s.revision}]}));
  if(!items.length)items.push({text:'普通讨论',evidence:[{segmentId:job.snapshot[0].id,revision:job.snapshot[0].revision}]});
  return{title:'分层纪要',sections:[{heading:'讨论与决定',items}],actions:[],usageTokens:10};
}
test('over-budget transcript is fully windowed, hierarchically synthesized and grounded to early/middle/late leaf evidence',async()=>{
  const f=await fixture();try{
    const claim=await f.claim();assert.ok(JSON.stringify(claim.snapshot).length>180000);let calls=0;
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{calls++;return summarize(job);});validateMinutes(result,claim.snapshot);
    assert.ok(result.coverage.windows>1);assert.equal(result.coverage.completed,result.coverage.windows);assert.ok(result.coverage.levels>=2);assert.equal(result.coverage.calls,calls);
    const text=JSON.stringify(result.sections);for(const fact of ['早期决定','中期风险','晚期撤回上线承诺'])assert.ok(text.includes(fact));
    await f.repo.change(f.record.id,r=>commitMinutes(r,claim.id,result,claim.fence));const record=await f.repo.get(f.record.id);assert.equal(record.minutes.coverage.segments,100);assert.equal(record.jobs[0].status,'completed');assert.ok(!JSON.stringify(publicRecord(record).jobs).includes('windowCache'));assert.equal(record.usage.llmTokens,calls*10);
  }finally{await f.close();}
});
test('failed window never publishes final; retry reuses persisted windows, revision invalidates affected windows only',async()=>{
  const f=await fixture();try{
    const first=await f.claim();let calls=0;await assert.rejects(runMinutesPipeline(f.repo,f.record.id,first,config,async job=>{if(++calls===3)throw new Error('provider disconnected');return summarize(job);}),/disconnected/);
    let record=await f.repo.get(f.record.id);assert.equal(record.minutes,null);assert.equal(record.jobs[0].progress.completed,2);assert.equal(record.jobs[0].windowCache.length,2);
    await f.repo.change(f.record.id,r=>{r.jobs[0].status='failed';r.jobs[0].snapshot=[];r.segments[0].text+=' 修订';r.segments[0].revision++;r.transcriptRevision++;emit(r,'transcript.edited',{});});
    const next=await f.claim();const oldKeys=buildMinutesManifest(first,config).windows.map(w=>w.key),newKeys=buildMinutesManifest(next,config).windows.map(w=>w.key);assert.equal(oldKeys.filter(key=>!newKeys.includes(key)).length,1);
    const result=await runMinutesPipeline(f.repo,f.record.id,next,config,async job=>summarize(job));assert.ok(result.coverage.reused>=1);await f.repo.change(f.record.id,r=>commitMinutes(r,next.id,result,next.fence));record=await f.repo.get(f.record.id);assert.equal(record.minutes.transcriptRevision,2);
  }finally{await f.close();}
});
test('revision, manual minutes edit, deletion and lost fence reject late provider results',async()=>{
  for(const mutation of [r=>{r.segments[0].revision++;r.transcriptRevision++;},r=>{r.minutesRevision++;},r=>{r.deleted=true;r.generation++;},r=>{r.jobs.at(-1).fence='new-owner';}]){
    const f=await fixture(2);try{const claim=await f.claim();let once=false;await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{if(!once){once=true;await f.repo.change(f.record.id,mutation);}return summarize(job);}),error=>['stale_job','minutes_snapshot_changed'].includes(error.code));assert.equal((await f.repo.get(f.record.id)).minutes,null);}finally{await f.close();}
  }
});
test('invalid evidence fails the window and final work supersedes live without accepting its late commit',async()=>{
  const f=await fixture(2);try{
    const claim=await f.claim();await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,config,async()=>({title:'bad',sections:[{heading:'bad',items:[{text:'hallucination',evidence:[{segmentId:'unknown',revision:1}]}]}]})),/evidence/);
    await f.repo.change(f.record.id,r=>{r.jobs=[];r.capture='recording';r.autoMinutes={enabled:true,intervalSeconds:30,enabledAt:1};const live=requestMinutes(r,{scope:'live',automatic:true});live.status='running';live.fence='old-live';r.capture='completed';const final=queueAutomaticMinutes(r,'fixture-model');assert.equal(final.scope,'final');assert.equal(live.status,'cancelled');assert.equal(live.fence,null);assert.throws(()=>commitMinutes(r,live.id,summarize({...live,snapshot:r.segments}),'old-live'),/stale_job/);});
  }finally{await f.close();}
});

test('worker completes long final minutes through real HTTP provider adapter and retains leaf citations',async()=>{
  const {createServer}=await import('node:http');const {generateMinutes}=await import('../services/records/src/providers.mjs');const {runCycle}=await import('../services/records/src/worker.mjs');
  const f=await fixture();let requests=0,synthesis=0,maxInputChars=0;
  const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body),input=JSON.parse(request.messages.at(-1).content);requests++;if(input.stage==='synthesis'){synthesis++;assert.ok(request.messages.some(message=>message.role==='system'&&message.content.includes('这是分层汇总阶段')));}maxInputChars=Math.max(maxInputChars,request.messages.at(-1).content.length);
    assert.equal(input.transcript[0].speaker,'发言人1');const result=summarize({snapshot:input.transcript,summaries:input.summaries});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],usage:{total_tokens:10}}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const env={LLM_MODEL:'fixture-model',LLM_API_KEY:'valid-local-test-key',LLM_PROTOCOL:'chat-completions',LLM_API_URL:`http://127.0.0.1:${server.address().port}/chat/completions`};
    await f.repo.change(f.record.id,r=>requestMinutes(r,{scope:'final',modelVersion:'fixture-model'}));
    await runCycle(f.repo,{minutes:(job,ignored,options)=>generateMinutes(job,env,options)},{lane:'minutes'});
    const record=await f.repo.get(f.record.id);assert.equal(record.jobs[0].status,'completed');assert.ok(synthesis>=2);assert.ok(requests>10);assert.ok(maxInputChars<180000);assert.equal(record.usage.llmTokens,requests*10);assert.ok(!JSON.stringify(record.minutes).includes('usageRecorded'));
    for(const fact of ['早期决定','中期风险','晚期撤回上线承诺'])assert.ok(JSON.stringify(record.minutes.sections).includes(fact));validateMinutes(record.minutes,record.segments);
  }finally{await new Promise(resolve=>server.close(resolve));await f.close();}
});


test('live requests coalesce while active and concurrent workers cannot claim the same record twice',async()=>{
  const {runCycle}=await import('../services/records/src/worker.mjs');const f=await fixture(2);
  try{
    await f.repo.change(f.record.id,r=>{r.capture='recording';r.autoMinutes={enabled:true,enabledAt:1,intervalSeconds:30};requestMinutes(r,{scope:'live',automatic:true});r.transcriptRevision++;assert.equal(queueAutomaticMinutes(r,'fixture-model'),undefined);const second=requestMinutes(r,{scope:'live'});assert.equal(r.jobs[0].status,'cancelled');r.transcriptRevision++;requestMinutes(r,{scope:'live'});assert.equal(second.status,'cancelled');assert.equal(r.jobs.filter(j=>['queued','running'].includes(j.status)).length,1);});
    let release,started;const ready=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);let calls=0;
    const first=runCycle(f.repo,{minutes:async job=>{calls++;started();await blocked;return summarize(job);}},{lane:'minutes'});await ready;
    await runCycle(f.repo,{minutes:async()=>assert.fail('concurrent duplicate')},{lane:'minutes'});assert.equal(calls,1);release();await first;assert.ok((await f.repo.get(f.record.id)).liveMinutes);
  }finally{await f.close();}
});


test('minutes rollback runs original provider path and cache policy changes with model, endpoint, notes and generation',async()=>{
  const {runCycle}=await import('../services/records/src/worker.mjs');const f=await fixture(2),previous=process.env.RECORD_MINUTES_PIPELINE_ENABLED;
  try{
    const claim=await f.claim(),original=buildMinutesManifest(claim,config).policy;
    for(const [job,env] of [[{...claim,notes:'changed',notesRevision:1},config],[{...claim,generation:2},config],[claim,{...config,LLM_API_URL:'http://different.invalid'}],[{...claim,modelVersion:'next-model'},config]])assert.notEqual(buildMinutesManifest(job,env).policy,original);
    await f.repo.change(f.record.id,r=>{r.jobs[0].status='queued';});process.env.RECORD_MINUTES_PIPELINE_ENABLED='false';let calls=0;
    await runCycle(f.repo,{minutes:async job=>{calls++;assert.equal(job.manifest,undefined);return summarize(job);}},{lane:'minutes'});assert.equal(calls,1);assert.equal((await f.repo.get(f.record.id)).jobs[0].status,'completed');
  }finally{if(previous===undefined)delete process.env.RECORD_MINUTES_PIPELINE_ENABLED;else process.env.RECORD_MINUTES_PIPELINE_ENABLED=previous;await f.close();}
});


test('a complete transcript within the byte budget needs only one streamed model call', async () => {
  const f=await fixture(80);
  try {
    await f.repo.change(f.record.id,r=>{r.segments.forEach(s=>{s.text='短发言。';});});
    const claim=await f.claim(); let calls=0,preview='';
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,config,async(job,env,options)=>{
      calls++; await options.onDelta?.('即时要点',{}); return summarize(job);
    },{onDelta:delta=>{preview+=delta;}});
    assert.equal(calls,1);
    assert.equal(result.coverage.segments,80);
    assert.equal(preview,'即时要点');
  } finally {await f.close();}
});


test('hierarchical minutes stream only the final synthesis into the visible preview', async () => {
  const f=await fixture(20);
  try {
    const claim=await f.claim();let preview='';
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,config,async(job,env,options)=>{
      await options.onDelta?.(job.stage==='synthesis'?'汇总':'中间窗口',{});return summarize(job);
    },{onDelta:delta=>{preview+=delta;}});
    assert.ok(result.coverage.calls>1);
    assert.equal(preview,'汇总');
  } finally {await f.close();}
});

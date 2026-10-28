import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,requestMinutes,commitMinutes,validateMinutes,publicRecord,emit} from '../packages/records/src/record.mjs';
import {queueAutomaticMinutes} from '../packages/records/src/automation.mjs';
import {buildMinutesManifest,runMinutesPipeline} from '../services/records/src/minutes-pipeline.mjs';
import {beginMinutesUsage,updateMinutesUsage} from '../packages/records/src/usage.mjs';
import {generateMinutes} from '../services/records/src/providers.mjs';
const config={LLM_MODEL:'fixture-model',LLM_API_URL:'http://fixture.invalid'};
test('live partial budgets count validated windows when one frozen source is split',async()=>{
  const f=await fixture(1);let claim,windows=0;
  const transcript=Array.from({length:6000},(_,index)=>String.fromCodePoint(0x4e00+index)).join('');
  const bounded={...config,RECORD_MINUTES_INPUT_BYTES:4096,RECORD_MINUTES_WINDOW_CONCURRENCY:1};
  try{
    await f.repo.change(f.record.id,record=>{
      record.capture='recording';
      Object.assign(record.segments[0],{text:transcript,startMs:0,endMs:30000});
      const job=requestMinutes(record,{scope:'live',modelVersion:'fixture-model'});
      job.status='running';job.fence=job.id;job.lease=Date.now()+300000;claim=structuredClone(job);
    });
    const manifest=buildMinutesManifest(claim,bounded);
    assert.ok(manifest.windows.length>=7);
    assert.equal(new Set(claim.snapshot.map(segment=>segment.id+':'+segment.revision)).size,1);
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,bounded,async job=>{
      if(job.stage==='synthesis'){
        const partial=(await f.repo.get(f.record.id)).jobs.find(entry=>entry.id===claim.id).partialMinutes;
        assert.ok(partial.sections.length>20,'all validated leaf sections remain visible before synthesis');
        return {title:'分窗汇总',sections:[{heading:'归并后的议题',items:job.summaries.flatMap(summary=>summary.sections.flatMap(section=>section.items))}],actions:[]};
      }
      windows++;
      const source=job.snapshot.find(segment=>segment.contextOnly!==true);
      const evidence=[{segmentId:source.id,revision:source.revision}];
      const leaf={title:'分窗纪要',sections:Array.from({length:3},(_,index)=>({heading:'窗口'+windows+'议题'+index,items:[{text:'窗口'+windows+'要点'+index,evidence}]})),actions:[]};
      validateMinutes(leaf,job.validationSnapshot,job.liveContext,{newEvidenceOnly:true});
      return leaf;
    });
    assert.equal(windows,manifest.windows.length);
    assert.equal(result.sections[0].items.length,windows*3);
    await f.repo.change(f.record.id,record=>commitMinutes(record,claim.id,result,claim.fence));
    const saved=await f.repo.get(f.record.id);
    assert.equal(saved.jobs.find(job=>job.id===claim.id).status,'completed');
    assert.equal(saved.liveMinutes.sections[0].items.length,windows*3);
    assert.equal(saved.liveMinutes.evidenceSnapshot[0].text,transcript);
  }finally{await f.close();}
});
test('synthesis includes original evidence within budget and explicitly marks omissions',async()=>{
  for(const synthesisBudget of [96000,4096]){
    const f=await fixture(8);let seen=false;
    try{
      const claim=await f.claim();
      await runMinutesPipeline(f.repo,f.record.id,claim,{...config,RECORD_MINUTES_INPUT_BYTES:4096,RECORD_MINUTES_SYNTHESIS_INPUT_BYTES:synthesisBudget},async job=>{
        if(job.stage==='synthesis'){
          seen=true;
          if(synthesisBudget===96000)assert.ok(job.snapshot.some(segment=>typeof segment.text==='string'));
          else assert.ok(job.omittedEvidence>0);
          assert.ok(Buffer.byteLength(JSON.stringify({transcript:job.snapshot,summaries:job.summaries,stage:job.stage,omittedEvidence:job.omittedEvidence}))<=synthesisBudget);
          return {title:'汇总',sections:[{heading:'讨论',items:job.summaries.flatMap(summary=>summary.sections.flatMap(section=>section.items))}],actions:[]};
        }
        const source=job.snapshot.find(segment=>!segment.contextOnly);
        return {title:'窗口',sections:[{heading:'讨论',items:[{text:source.id,evidence:[{segmentId:source.id,revision:source.revision}]}]}],actions:[]};
      });
      assert.ok(seen);
    }finally{await f.close();}
  }
});
test('partial correction state follows event order even when later windows finish first',async()=>{
  const f=await fixture(1);let release,run,claim;
  const gate=new Promise(resolve=>{release=resolve;});
  try{
    await f.repo.change(f.record.id,r=>{
      const old=r.segments[0],evidence=[{segmentId:old.id,revision:1}];
      r.capture='recording';r.liveMinutes={title:'上线',template:'meeting',notesRevision:0,transcriptRevision:1,sections:[{heading:'安排',items:[{id:'plan',text:'周五上线',evidence}]}],decisions:[{id:'plan',text:'周五上线',evidence}],actions:[],evidenceSnapshot:[old]};
      r.segments.push({...old,id:'new-early',text:'周五上线待确认',startMs:200000,endMs:201000},{...old,id:'new-late',text:'取消周五上线',startMs:400000,endMs:401000});r.transcriptRevision++;
      const job=requestMinutes(r,{scope:'live'});job.status='running';job.fence=job.id;claim=structuredClone(job);
    });
    run=runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
      let correction;
      if(job.stage==='synthesis')correction=job.summaries.flatMap(summary=>summary.corrections || []).at(-1);
      else{
        const source=job.snapshot.find(segment=>!segment.contextOnly);
        if(source.id==='new-early')await gate;
        correction={targetId:claim.liveContext.items.find(item=>item.kind==='decision').id,status:source.id==='new-early'?'pending':'withdrawn',text:source.text,evidence:[{segmentId:source.id,revision:1}]};
      }
      return {title:'上线',sections:[{heading:'安排',items:[]}],actions:[],decisions:[],corrections:[correction]};
    });
    let partial;
    for(let attempt=0;attempt<100;attempt++){
      partial=(await f.repo.get(f.record.id)).jobs.at(-1).partialMinutes;
      if(partial?.correctionHistory?.length)break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(partial.correctionHistory.at(-1).status,'withdrawn');
    release();await run;
    partial=(await f.repo.get(f.record.id)).jobs.at(-1).partialMinutes;
    assert.equal(partial.correctionHistory.at(-1).status,'withdrawn');assert.equal(partial.decisions.length,0);
  }finally{release();await run?.catch(()=>{});await f.close();}
});
test('text windows batch five minutes while audio windows keep their two-minute cap',()=>{
 const snapshot=Array.from({length:20},(_,i)=>({id:`timed-${i}`,sourceId:'mic',revision:1,text:'短句',startMs:i*30000,endMs:i*30000+1000}));
 const job={snapshot,scope:'final',notes:'',modelVersion:'default'};
 const manifest=buildMinutesManifest(job,config),audio=buildMinutesManifest(job,{...config,MINUTES_MODE:'doubao-audio'});
 assert.deepEqual(manifest.windows.map(w=>w.snapshot.filter(s=>!s.contextOnly).map(s=>s.id)),[snapshot.slice(0,10).map(s=>s.id),snapshot.slice(10).map(s=>s.id)]);
 assert.equal(audio.windows.length,5);
 assert.equal(manifest.windows.flatMap(w=>w.snapshot.filter(segment=>!segment.contextOnly)).length,snapshot.length);
 assert.ok(manifest.windows[0].snapshot.some(segment=>segment.id==='timed-10'&&segment.contextOnly));
});

test('switching templates treats the full transcript as new rather than context-only evidence',()=>{
  const record=createRecord('owner');record.capture='recording';record.transcriptRevision=1;
  record.segments=[{id:'earlier',revision:1,text:'项目讨论',startMs:0,endMs:1000}];
  record.liveMinutes={template:'meeting',notesRevision:0,evidenceSnapshot:[...record.segments],title:'项目周会',topics:[],sections:[]};
  const job=requestMinutes(record,{scope:'live',template:'interview'});
  assert.equal(job.snapshot.length,1);assert.equal(job.snapshot[0].contextOnly,false);
});
async function fixture(count=100){
  const root=await mkdtemp(join(tmpdir(),'minutes-pipeline-')),repo=await createRepository({root});
  const record=createRecord('owner',{title:'Long transcript',language:'zh'});record.capture='completed';record.transcription='completed';record.transcriptRevision=1;
  record.segments=Array.from({length:count},(_,i)=>({id:`s-${i}`,revision:1,sourceId:'mic',speakerId:'speaker-1',speaker:'发言人1',startMs:i*1000,endMs:(i+1)*1000,text:'x'.repeat(2200)+(i===0?' FACT:早期决定':i===50?' FACT:中期风险':i===99?' FACT:晚期撤回上线承诺':'')}));await repo.insert(record);
  return{repo,record,async claim(){let claim;await repo.change(record.id,r=>{const job=requestMinutes(r,{scope:'final',modelVersion:'fixture-model'});job.status='running';job.fence=`f-${job.id}`;job.lease=Date.now()+300000;claim=structuredClone(job);});return claim;},async close(){await repo.close();await rm(root,{recursive:true,force:true});}};
}
function summarize(job){
  assert.ok(JSON.stringify({transcript:job.snapshot,notes:job.notes,summaries:job.summaries}).length<180000,'provider request budget');
  const items=job.summaries ? job.summaries.flatMap(result=>result.sections.flatMap(section=>section.items)).filter(item=>item.text.includes('FACT:')) : job.snapshot.filter(s=>!s.contextOnly&&s.text.includes('FACT:')).map(s=>({text:s.text.slice(s.text.indexOf('FACT:')),evidence:[{segmentId:s.id,revision:s.revision}]}));
  if(!items.length){const source=job.snapshot.find(segment=>!segment.contextOnly);if(source)items.push({text:'普通讨论',evidence:[{segmentId:source.id,revision:source.revision}]});}
  return{title:'分层纪要',sections:[{heading:'讨论与决定',items}],actions:[],usageTokens:10};
}
test('actual-call usage is idempotent across duplicate concurrent frames and remains separate from stale content fences',async()=>{
 const f=await fixture(1);
 try {
  const claim=await f.claim(),callId='synthetic-call';
  await f.repo.change(f.record.id,r=>{assert.equal(beginMinutesUsage(r,claim,callId),true);assert.equal(beginMinutesUsage(r,claim,callId),false);});
  await Promise.all([5,5,8,7].map(total=>f.repo.change(f.record.id,r=>updateMinutesUsage(r,claim,callId,{totalTokens:total,inputTokens:4,outputTokens:4}))));
  let record=await f.repo.get(f.record.id);assert.equal(record.usage.llmTokens,8);assert.deepEqual(record.usage.minutesMeter,{requests:1,reportedRequests:1,inputTokens:4,inputTokensRequests:1,outputTokens:4,outputTokensRequests:1,totalTokens:8,totalTokensRequests:1});
  assert.equal(publicRecord(record).jobs[0].usageCalls,undefined);
  await f.repo.change(f.record.id,r=>{r.minutesRevision++;r.minutes={title:'人工保护',edited:true};r.jobs[0].fence='new-owner';updateMinutesUsage(r,claim,callId,{totalTokens:10});});
  record=await f.repo.get(f.record.id);assert.equal(record.usage.llmTokens,10);assert.equal(record.minutes.title,'人工保护');
  await f.repo.change(f.record.id,r=>{r.deleted=true;r.generation++;assert.equal(updateMinutesUsage(r,claim,callId,{totalTokens:99}),false);});
  record=await f.repo.get(f.record.id);assert.equal(record.usage.llmTokens,10);assert.equal(record.deleted,true);
 } finally {await f.close();}
});
test('reported provider use survives output validation failure while missing usage stays unknown and cached windows add nothing',async()=>{
 const f=await fixture(1);
 try {
  const claim=await f.claim();
  await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,config,async(_job,_config,{onUsage})=>{await onUsage({inputTokens:10,outputTokens:2,totalTokens:12});return {title:'无有效引用',sections:[{heading:'无效',items:[{text:'无证据',evidence:[]}]}],actions:[],usageReported:true,usageTokens:12};}),{code:'missing_evidence'});
  let record=await f.repo.get(f.record.id);assert.equal(record.minutes,null);assert.equal(record.usage.llmTokens,12);assert.equal(record.usage.minutesMeter.totalTokens,12);
  await f.repo.change(f.record.id,r=>{r.jobs[0].status='failed';});const fresh=await f.claim();
  await runMinutesPipeline(f.repo,f.record.id,fresh,config,async job=>({...summarize(job),usageTokens:0,usageReported:false,tokenUsage:{}}));
  record=await f.repo.get(f.record.id);assert.equal(record.usage.llmTokens,12);assert.equal(record.usage.minutesMeter.requests,2);assert.equal(record.usage.minutesMeter.totalTokensRequests,1);
  const requests=record.usage.minutesMeter.requests;
  await runMinutesPipeline(f.repo,f.record.id,fresh,config,async()=>{assert.fail('cached leaf should not invoke the model');});
  record=await f.repo.get(f.record.id);assert.equal(record.usage.minutesMeter.requests,requests);assert.equal(record.usage.llmTokens,12);
 } finally {await f.close();}
});
test('local validation failure before a provider request does not manufacture a metered request or zero tokens',async()=>{
 const f=await fixture(1);
 try {
  const claim=await f.claim();
  await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,{...config,LLM_API_KEY:''},generateMinutes),{code:'minutes_not_configured'});
  const record=await f.repo.get(f.record.id);assert.equal(record.usage.llmTokens,0);assert.equal(record.usage.minutesMeter,undefined);assert.equal(record.jobs[0].usageCalls,undefined);
 } finally {await f.close();}
});
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
    let record=await f.repo.get(f.record.id);assert.equal(record.minutes,null);assert.equal(record.jobs[0].progress.completed,calls-1);assert.equal(record.jobs[0].windowCache.length,calls-1);assert.equal(record.usage.llmTokens,(calls-1)*10);
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

test('independent windows overlap within a bounded limit and retain transcript order for synthesis', async () => {
  const f=await fixture(32);
  let release,started,run;
  const held=new Promise(resolve=>{release=resolve;});
  const firstStarted=new Promise(resolve=>{started=resolve;});
  let active=0,maxActive=0,startedWindows=0;
  const completionOrder=[];
  try {
    const claim=await f.claim();
    const manifest=buildMinutesManifest(claim,config);
    assert.ok(manifest.windows.length>2);
    run=runMinutesPipeline(f.repo,f.record.id,claim,{...config,RECORD_MINUTES_WINDOW_CONCURRENCY:'2'},async job=>{
      active++;maxActive=Math.max(maxActive,active);
      try {
        if(job.stage!=='synthesis') {
          startedWindows++;started();await held;
          if(job.snapshot[0].id===manifest.windows[0].snapshot[0].id) await new Promise(resolve=>setImmediate(resolve));
          const source=job.snapshot.find(segment=>!segment.contextOnly);
          completionOrder.push(source.id);
          return {title:'window',sections:[{heading:'window',items:[{text:source.id,evidence:[{segmentId:source.id,revision:1}]}]}],actions:[],usageTokens:10};
        }
        assert.deepEqual(job.summaries.map(summary=>summary.sections[0].items[0].text),manifest.windows.map(window=>window.snapshot.find(segment=>!segment.contextOnly).id));
        return summarize(job);
      } finally {active--;}
    });
    await firstStarted;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(startedWindows,2,'a second independent window should start while the first is waiting');
    assert.equal(maxActive,2);
    release();const result=await run;
    assert.notEqual(completionOrder[0],manifest.windows[0].snapshot[0].id);
    assert.equal(result.coverage.completed,manifest.windows.length);
    assert.equal(result.coverage.calls,manifest.windows.length+1);
    assert.equal((await f.repo.get(f.record.id)).usage.llmTokens,result.coverage.calls*10);
  } finally {release();await run?.catch(()=>{});await f.close();}
});

test('window failure stops new work and drains successful in-flight usage before rejecting', async () => {
  const f=await fixture(32);
  let fail,release,started,run;
  const failure=new Promise(resolve=>{fail=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const initialStarted=new Promise(resolve=>{started=resolve;});
  let calls=0,settled=false;
  try {
    const claim=await f.claim();
    run=runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
      calls++;
      if(calls===1){await failure;throw new Error('window-disconnected');}
      if(calls===2){started();await held;return summarize(job);}
      assert.fail('no new window should start after failure');
    });
    const verdict=assert.rejects(run,/window-disconnected/).then(()=>{settled=true;});
    await initialStarted;fail();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'the failed job must retain its fence until the other provider result is drained');
    assert.equal(calls,2);
    release();await verdict;
    const record=await f.repo.get(f.record.id);
    assert.equal(record.jobs[0].windowCache.length,1);
    assert.equal(record.jobs[0].progress.completed,1);
    assert.equal(record.usage.llmTokens,10);
    assert.equal(record.minutes,null);
  } finally {fail();release();await run?.catch(()=>{});await f.close();}
});

test('concurrent identical split windows share one provider request and account usage once', async () => {
  const f=await fixture(1);
  try {
    await f.repo.change(f.record.id,r=>{r.segments[0].text='x'.repeat(12000);});
    const claim=await f.claim(),env={...config,RECORD_MINUTES_INPUT_BYTES:'4096'};
    const manifest=buildMinutesManifest(claim,env);
    assert.equal(manifest.windows.length,4);
    assert.equal(new Set(manifest.windows.map(window=>window.key)).size,1);
    let calls=0;
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,env,async job=>{
      calls++;await new Promise(resolve=>setImmediate(resolve));return summarize(job);
    });
    assert.equal(calls,2,'one shared leaf window plus final synthesis');
    assert.equal(result.coverage.completed,4);
    assert.equal(result.coverage.reused,3);
    assert.equal(result.usageTokens,20);
    assert.equal((await f.repo.get(f.record.id)).usage.llmTokens,20);
  } finally {await f.close();}
});

test('incremental live snapshots process only new segments with a two-minute overlap and retain earlier facts', async t => {
  const f=await fixture(160);
  try {
    await f.repo.change(f.record.id,r=>{r.capture='recording';});
    const claimLive=async()=>{
      let claim;
      await f.repo.change(f.record.id,r=>{const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence=job.id;claim=structuredClone(job);});
      return claim;
    };
    const first=await claimLive();
    const previous=await runMinutesPipeline(f.repo,f.record.id,first,config,async job=>summarize(job));
    await f.repo.change(f.record.id,r=>{
      commitMinutes(r,first.id,previous,first.fence);
      r.segments.push({...r.segments.at(-1),id:'s-160',startMs:160000,endMs:161000});r.transcriptRevision++;
    });
    const next=await claimLive();let generatedWindows=0;
    const result=await runMinutesPipeline(f.repo,f.record.id,next,config,async job=>{if(job.stage!=='synthesis')generatedWindows++;return summarize(job);});
    assert.equal(first.snapshot.length,160);assert.ok(next.snapshot.length>=121);
    assert.ok(next.snapshot.some(segment=>segment.id==='s-40'));assert.equal(next.snapshot[0].contextOnly,true);assert.equal(next.snapshot.at(-1).contextOnly,false);
    assert.ok(next.liveContext.headings.includes('讨论与决定'));
    assert.equal(publicRecord(await f.repo.get(f.record.id)).jobs.at(-1).liveContext,undefined);
    assert.ok(generatedWindows>0);
    assert.equal(result.coverage.completed,result.coverage.windows);
    t.diagnostic(JSON.stringify({initialCalls:previous.coverage.calls,rollingCalls:result.coverage.calls,generatedWindows,reused:result.coverage.reused}));
    validateMinutes(result,next.snapshot);
    await f.repo.change(f.record.id,r=>commitMinutes(r,next.id,result,next.fence));
    const record=await f.repo.get(f.record.id);
    assert.equal(record.liveMinutes.transcriptRevision,2);
    assert.equal(record.liveMinutes.evidenceSnapshot.length,161);
    assert.ok(record.liveMinutes.sections.flatMap(section=>section.items).some(item=>item.text.includes('早期决定')));
    assert.equal(record.jobs.at(-1).status,'completed');
  } finally {await f.close();}
});

test('legacy and malformed snapshot offsets retain zero-offset manifest compatibility', async () => {
  const f=await fixture(32);
  try {
    const claim=await f.claim(),expected=buildMinutesManifest({...claim,snapshotOffset:0},config);
    for(const snapshotOffset of [undefined,-1,1.5,NaN,Infinity,'24']){
      const actual=buildMinutesManifest({...claim,snapshotOffset},config);
      assert.equal(actual.snapshotOffset,0);
      assert.deepEqual(actual.windows,expected.windows);
    }
  } finally {await f.close();}
});

test('reused live windows cannot publish after a transcript edit, manual minutes edit or lost fence', async () => {
  for(const mutation of [r=>{r.segments[80].revision++;r.transcriptRevision++;},r=>{r.minutesRevision++;},r=>{r.jobs.at(-1).fence='replacement';}]){
    const f=await fixture(160);
    try {
      let claim;
      const claimLive=()=>f.repo.change(f.record.id,r=>{const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence=job.id;claim=structuredClone(job);});
      await f.repo.change(f.record.id,r=>{r.capture='recording';});
      await claimLive();
      const first=await runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>summarize(job));
      await f.repo.change(f.record.id,r=>{commitMinutes(r,claim.id,first,claim.fence);r.segments.push({...r.segments.at(-1),id:'s-160'});r.transcriptRevision++;});
      await claimLive();let changed=false;
      await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
        if(!changed){changed=true;await f.repo.change(f.record.id,mutation);}return summarize(job);
      }),error=>['stale_job','minutes_snapshot_changed'].includes(error.code));
      const record=await f.repo.get(f.record.id);
      assert.equal(record.liveMinutes.transcriptRevision,1);
      assert.equal(record.jobs.at(-1).status,'running');
    } finally {await f.close();}
  }
});

test('independent synthesis groups overlap while the final synthesis waits for the whole layer', async () => {
  const f=await fixture(100);let release,started,run,synthesisStarted=0;
  const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  try {
    const claim=await f.claim();
    run=runMinutesPipeline(f.repo,f.record.id,claim,{...config,RECORD_MINUTES_INPUT_BYTES:20000},async job=>{
      if(job.stage==='synthesis'&&job.summaries.length>2){synthesisStarted++;started();await held;}
      return summarize(job);
    });
    await ready;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(synthesisStarted,2);release();
    const result=await run;assert.equal(result.coverage.levels,2);validateMinutes(result,claim.snapshot);
  } finally {release();await run?.catch(()=>{});await f.close();}
});

test('window concurrency can roll back to serial execution and remains bounded for oversized settings', async () => {
  for(const [setting,limit] of [['1',1],['99',4],['invalid',2]]){
    const f=await fixture(32);let release,started,run,count=0;
    const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
    try {
      const claim=await f.claim();
      run=runMinutesPipeline(f.repo,f.record.id,claim,{...config,RECORD_MINUTES_WINDOW_CONCURRENCY:setting},async job=>{
        count++;started();await held;return summarize(job);
      });
      await ready;await new Promise(resolve=>setImmediate(resolve));assert.equal(count,limit);release();await run;
    } finally {release();await run?.catch(()=>{});await f.close();}
  }
});

test('model prompts preserve table topic associations and rebuild IDs during synthesis', async () => {
  const {generateMinutes}=await import('../services/records/src/providers.mjs');
  const original=globalThis.fetch;
  const snapshot=[{id:'s',revision:1,text:'合成内容'}],evidence=[{segmentId:'s',revision:1}];
  const response={title:'synthetic',sections:[{heading:'讨论',items:[{text:'合成内容',evidence}]}],topics:[{id:'t1',title:'主题',summary:'合成内容',evidence}],tables:[{title:'表格',topicId:'t1',columns:['事项','状态'],rows:[{cells:['事项','待确认'],evidence}]}],actions:[]};
  let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}]}),{headers:{'Content-Type':'application/json'}});};
  try {
    const env={LLM_API_URL:'https://unused.invalid',LLM_API_KEY:'synthetic-local-key',LLM_MODEL:'synthetic',LLM_PROTOCOL:'chat-completions'};
    for(const stage of [undefined,'synthesis']){
      const result=await generateMinutes({scope:'live',template:'meeting',snapshot,stage,liveContext:{title:'项目周会',topics:[{id:'t1',title:'唐山项目'}],headings:['唐山项目']},summaries:stage?[response,response]:undefined},env);
      assert.equal(result.topics[0].id,'t1');assert.equal(result.tables[0].topicId,'t1');validateMinutes(result,snapshot);
      const prompt=request.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n');
      assert.ok(prompt.includes('topics:[{id:string'));
      assert.ok(prompt.includes('topicId:string'));
      assert.equal(JSON.parse(request.messages.find(message=>message.role==='user').content).context.topics[0].title,'唐山项目');
      assert.ok(prompt.includes('沿用 context.topics'));
      assert.ok(prompt.includes('不能仅因都提到相机就合并不同项目'));
      assert.ok(prompt.includes('每张表必须完整归属一个主题'));
      assert.ok(prompt.includes('每行仍须引用给定片段整数索引（服务端还原ID与revision）'));
      if(stage)assert.ok(prompt.includes('重新分配唯一主题 id'));
    }
  } finally {globalThis.fetch=original;}
});

test('old completed v5 jobs do not block explicit v6 requests, while new requests remain idempotent', async () => {
  const f=await fixture(2);
  try {
    let oldId,newId;
    await f.repo.change(f.record.id,r=>{
      const previous=requestMinutes(r,{modelVersion:'fixture-model'});oldId=previous.id;
      previous.key=previous.key.replace(':v6:',':v5:');previous.status='completed';previous.snapshot=[];
      r.minutes={...summarize({snapshot:r.segments}),revision:1,edited:true};r.minutesRevision=1;
      r.autoMinutes={enabled:true,lastRevision:r.transcriptRevision,lastScope:'final',intervalSeconds:30};
      assert.equal(queueAutomaticMinutes(r,'fixture-model'),undefined,'format upgrades must not auto-replace an edited minutes version');
      const current=requestMinutes(r,{modelVersion:'fixture-model'});newId=current.id;
      assert.notEqual(newId,oldId);assert.ok(current.key.includes(':v6:'));
      assert.equal(requestMinutes(r,{modelVersion:'fixture-model'}).id,newId);
      assert.equal(r.minutes.edited,true);
      assert.equal(r.minutesRevision,1);
      current.status='running';current.fence=current.id;
    });
    const record=await f.repo.get(f.record.id),claim=structuredClone(record.jobs.find(job=>job.id===newId));
    await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
      await f.repo.change(f.record.id,r=>{r.minutesRevision++;r.minutes.title='新增人工修改';});return summarize(job);
    }),error=>error.code==='minutes_snapshot_changed');
    const latest=await f.repo.get(f.record.id);assert.equal(latest.minutes.title,'新增人工修改');assert.equal(latest.minutes.edited,true);
  } finally {await f.close();}
});

test('legal rich summaries larger than the transcript window budget synthesize without dropping topics, tables or evidence', async () => {
  const f=await fixture(2);
  try {
    await f.repo.change(f.record.id,r=>{r.segments.forEach(segment=>{segment.text='x'.repeat(16000);});});
    const claim=await f.claim(),manifest=buildMinutesManifest(claim,config),leaves=[];let synthesis=0;
    assert.equal(manifest.windows.length,2);
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
      if(job.stage==='synthesis'){
        synthesis++;
        const bytes=Buffer.byteLength(JSON.stringify({transcript:job.snapshot,notes:job.notes,summaries:job.summaries,stage:job.stage}));
        assert.ok(bytes>manifest.budget);assert.ok(bytes<=96000);
        assert.deepEqual(job.summaries,leaves.map(({usageTokens:_usageTokens,...leaf})=>leaf));
        return {title:'完整综合',sections:job.summaries.flatMap(summary=>summary.sections),topics:job.summaries.flatMap(summary=>summary.topics),tables:job.summaries.flatMap(summary=>summary.tables),actions:[],usageTokens:10};
      }
      const id=job.snapshot[0].id,evidence=[{segmentId:id,revision:1}];
      const summary={title:`窗口 ${id}`,sections:[{heading:`主题 ${id}`,items:[{text:`FACT:${id}:明确决定 `+'x'.repeat(5000),evidence},{text:`FACT:${id}:保留风险 `+'y'.repeat(5000),evidence}]}],topics:[{id:`topic-${id}`,title:`主题 ${id}`,summary:'主题背景'.repeat(500),evidence}],tables:[{title:`统计 ${id}`,topicId:`topic-${id}`,columns:['事项','状态'],rows:[{cells:[`FACT:${id}:表格事实`,'z'.repeat(900)],evidence}]}],actions:[],usageTokens:10};
      validateMinutes(summary,job.snapshot);leaves.push(summary);return summary;
    });
    validateMinutes(result,claim.snapshot);assert.equal(synthesis,1);assert.equal(result.coverage.calls,3);assert.equal(result.coverage.levels,1);
    assert.deepEqual(result.topics,leaves.flatMap(summary=>summary.topics));assert.deepEqual(result.tables,leaves.flatMap(summary=>summary.tables));assert.deepEqual(result.sections,leaves.flatMap(summary=>summary.sections));
    await f.repo.change(f.record.id,r=>commitMinutes(r,claim.id,result,claim.fence));
    assert.equal((await f.repo.get(f.record.id)).jobs[0].status,'completed');
  } finally {await f.close();}
});

test('synthesis budget is independently bounded without invalidating reusable transcript windows', async () => {
  const f=await fixture(32);
  try {
    const claim=await f.claim(),baseline=buildMinutesManifest(claim,config);
    assert.equal(baseline.budget,24000);assert.equal(baseline.synthesisBudget,96000);
    for(const [setting,expected] of [['32000',32000],['1',4096],['1000000',96000],['invalid',96000],['Infinity',96000]]){
      const manifest=buildMinutesManifest(claim,{...config,RECORD_MINUTES_SYNTHESIS_INPUT_BYTES:setting});
      assert.equal(manifest.synthesisBudget,expected);
      assert.equal(manifest.policy,baseline.policy);assert.deepEqual(manifest.windows,baseline.windows);
    }
  } finally {await f.close();}
});

test('summaries beyond the synthesis hard cap fail finitely without truncation or singleton resummarization', async () => {
  const f=await fixture(2);let calls=0;
  try {
    await f.repo.change(f.record.id,r=>{r.segments.forEach(segment=>{segment.text='x'.repeat(16000);});});
    const claim=await f.claim(),env={...config,RECORD_MINUTES_SYNTHESIS_INPUT_BYTES:'1000000'};
    assert.equal(buildMinutesManifest(claim,env).synthesisBudget,96000);
    await assert.rejects(runMinutesPipeline(f.repo,f.record.id,claim,env,async job=>{
      calls++;assert.notEqual(job.stage,'synthesis','a pair that exceeds the hard cap must never be sent or endlessly compacted');
      const evidence=[{segmentId:job.snapshot[0].id,revision:1}];
      const summary={title:'合法大摘要',sections:[{heading:'所有重要事实',items:Array.from({length:7},(_,index)=>({text:`FACT:${index} `+'x'.repeat(7500),evidence}))}],actions:[],usageTokens:10};
      validateMinutes(summary,job.snapshot);return summary;
    }),error=>error.code==='minutes_intermediate_too_large');
    assert.equal(calls,2);
    const record=await f.repo.get(f.record.id);assert.equal(record.minutes,null);assert.equal(record.jobs[0].windowCache.length,2);
    for(const window of record.jobs[0].windowCache){assert.equal(window.result.sections[0].items.length,7);assert.ok(window.result.sections[0].items.every(item=>item.text.length>7500));}
  } finally {await f.close();}
});

test('multi-window live minutes forward the first visible text before any window completes',async()=>{
 const f=await fixture(30);let release,started,work;
 const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});const deltas=[];
 try{
  await f.repo.change(f.record.id,r=>{r.capture='recording';const j=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});j.status='running';j.fence=j.id;});
  const claim=(await f.repo.get(f.record.id)).jobs.at(-1);assert.ok(buildMinutesManifest(claim,config).windows.length>1);
  work=runMinutesPipeline(f.repo,f.record.id,claim,config,async(job,env,options)=>{
   await options.onDelta?.('{"title":"已经开始整理"',{firstTokenMs:15});started();await gate;return summarize(job);
  },{onDelta:delta=>{deltas.push(delta);}});
  await ready;assert.ok(deltas.some(delta=>delta.includes('已经开始整理')),'first visible text must not wait for whole window completion');
 }finally{release();await work;await f.close();}
});

test('validated window minutes appear before slower windows and final synthesis finish', async () => {
  const f=await fixture(30); let release, started;
  const gate=new Promise(resolve=>{release=resolve;}), ready=new Promise(resolve=>{started=resolve;});
  try {
    await f.repo.change(f.record.id,r=>{r.jobs=[];r.capture='recording';const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence=job.id;});
    const claim=(await f.repo.get(f.record.id)).jobs.at(-1);
    const pending=runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
      if(job.snapshot[0].id!=='s-0'){started();await gate;} return summarize(job);
    });
    await ready;
    let record;
    for(let i=0;i<100;i++){record=await f.repo.get(f.record.id);if(record.jobs.at(-1).partialMinutes)break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(record.liveMinutes,null);
    const partial=publicRecord(record).jobs.at(-1).partialMinutes;
    assert.ok(partial.sections.flatMap(section=>section.items).some(item=>item.text.includes('早期决定')));
    validateMinutes(partial,partial.evidenceSnapshot); assert.ok(partial.evidenceSnapshot.length<claim.snapshot.length);
    release();await pending;
  } finally {release();await f.close();}
});

test('incremental project context survives long sessions and an edit to earlier evidence invalidates the in-flight result', async () => {
  const f=await fixture(160);
  try {
    let first;
    await f.repo.change(f.record.id,r=>{r.jobs=[];r.capture='recording';const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence=job.id;first=structuredClone(job);});
    const ref={segmentId:'s-0',revision:1};
    const old={title:'项目周会',topics:[{id:'project-tangshan',title:'唐山项目',summary:'相机问题与排查',evidence:[ref]}],sections:[{heading:'唐山项目',items:[{text:'唐山相机断连，需要查明根因。',evidence:[ref]}]}],actions:[]};
    await f.repo.change(f.record.id,r=>{commitMinutes(r,first.id,old,first.fence);r.segments.push({...r.segments.at(-1),id:'s-160',text:'相机恢复后仍需排查。'});r.transcriptRevision++;});
    let claim;
    await f.repo.change(f.record.id,r=>{const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence=job.id;claim=structuredClone(job);});
    assert.equal(claim.snapshot.length,123);assert.equal(claim.liveContext.topics[0].title,'唐山项目');
    const result=await runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
      assert.equal(job.liveContext.topics[0].id,'project-tangshan');
      if(!job.snapshot.some(segment=>segment.id==='s-160'))return summarize(job);
      return {title:'相机恢复',topics:[{id:job.liveContext.topics[0].id,title:job.liveContext.topics[0].title,summary:'恢复后仍需排查',evidence:[{segmentId:'s-160',revision:1}]}],sections:[{heading:'唐山项目',items:[{text:'恢复后仍需排查。',evidence:[{segmentId:'s-160',revision:1}]}]}],actions:[]};
    });
    await f.repo.change(f.record.id,r=>commitMinutes(r,claim.id,result,claim.fence));
    const updated=await f.repo.get(f.record.id);
    assert.equal(updated.liveMinutes.topics.length,1);assert.equal(updated.liveMinutes.sections[0].items.length,2);
    assert.equal(updated.liveMinutes.evidenceSnapshot.length,161);
    let stale;
    await f.repo.change(f.record.id,r=>{r.segments.push({...r.segments.at(-1),id:'s-161'});r.transcriptRevision++;const job=requestMinutes(r,{scope:'live'});job.status='running';job.fence=job.id;stale=structuredClone(job);r.segments[0].revision++;r.transcriptRevision++;});
    await assert.rejects(runMinutesPipeline(f.repo,f.record.id,stale,config,summarize),{code:'minutes_snapshot_changed'});
    await f.repo.change(f.record.id,r=>{const next=requestMinutes(r,{scope:'live'});assert.equal(next.snapshot.length,162);assert.equal(next.liveContext,undefined);});
  } finally {await f.close();}
});

test('project memory is bounded while preserving stable identities and cumulative facts', async () => {
  const {minutesContext,mergeLiveMinutes}=await import('../packages/records/src/live-minutes.mjs');
  const evidence=[{segmentId:'s',revision:1}],snapshot=[{id:'s',revision:1,text:'安排'}];
  const previous={title:'长会议',topics:Array.from({length:30},(_,i)=>({id:'项目'+String(i).padStart(2,'0')+'名'.repeat(70),title:'项目'+i+'名'.repeat(190),summary:'进展'+i+'已确认'.repeat(100)})),sections:Array.from({length:20},(_,i)=>({heading:'分类'+i+'名'.repeat(190),items:[]})),decisions:[{text:'旧项目的评审安排仍保留',evidence}]};
  previous.sections[0].items=[{text:'旧会议事实仍保留',evidence}];
  const original=structuredClone(previous),related=previous.topics[5],recent=previous.topics.at(-1);
  const context=minutesContext(previous,[{id:'new',revision:1,text:related.title+'；'+recent.title+'：跟进评审安排。'}]);
  assert.ok(Buffer.byteLength(JSON.stringify(context))<=12000);
  assert.ok(context.topics.length>0&&context.topics.length<previous.topics.length);
  const known=new Map(previous.topics.map(topic=>[topic.id,topic]));
  for(const topic of context.topics){
    assert.ok(known.has(topic.id),'retained identities are unchanged');
    if(topic.summary!==undefined)assert.equal(topic.summary,known.get(topic.id).summary.slice(0,160));
  }
  assert.ok(context.topics.some(topic=>topic.id===related.id));
  assert.ok(context.topics.some(topic=>topic.id===recent.id));
  assert.ok(context.items.some(item=>item.text==='旧项目的评审安排仍保留'));
  assert.deepEqual(previous,original,'prompt clipping must not discard or mutate stored facts');
  const base={title:'项目会',sections:[{heading:'安排',items:[{text:'排查相机',evidence}]}],actions:[{text:'排查相机',owner:'已确认负责人',due:'今天',evidence}],evidenceSnapshot:snapshot};
  const delta={title:'最新讨论',sections:[{heading:'安排',items:[{text:'排查相机',evidence}]}],actions:[{text:'排查相机',owner:null,due:null,evidence}]};
  const result=mergeLiveMinutes(base,delta,snapshot);
  assert.equal(result.sections[0].items.length,1);assert.equal(result.actions[0].owner,null);
  assert.equal(result.actions[0].due,null);assert.equal(result.title,'项目会');
});

test('partial citations retain the complete frozen transcript when a provider window splits a long segment', async () => {
  const f=await fixture(1);let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  try {
    const original='完整原文：'+'内容'.repeat(20000);let claim;
    await f.repo.change(f.record.id,r=>{r.segments[0].text=original;r.jobs=[];r.capture='recording';const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence=job.id;claim=structuredClone(job);});
    let calls=0;
    const pending=runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{if(++calls>1){started();await gate;}return summarize(job);});
    await ready;let partial;
    for(let i=0;i<100;i++){partial=(await f.repo.get(f.record.id)).jobs[0].partialMinutes;if(partial)break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(partial.evidenceSnapshot[0].text,original);validateMinutes(partial,partial.evidenceSnapshot);
    release();await pending;
  } finally {release();await f.close();}
});

test('a legacy in-flight live job cannot overwrite a newer cumulative result after upgrade', async () => {
  const f=await fixture(2);
  try {
    await f.repo.change(f.record.id,r=>{
      r.jobs=[];r.capture='recording';
      const old=requestMinutes(r,{scope:'live'});delete old.liveBaseHash;old.status='running';old.fence=old.id;
      r.segments.push({...r.segments.at(-1),id:'s-2'});r.transcriptRevision++;
      const next=requestMinutes(r,{scope:'live'});next.status='running';next.fence=next.id;
      commitMinutes(r,next.id,summarize(next),next.fence);
      const current=r.liveMinutes;commitMinutes(r,old.id,summarize(old),old.fence);
      assert.equal(old.status,'stale');assert.equal(r.liveMinutes,current);
    });
  } finally {await f.close();}
});

test('changing reasoning strength invalidates cached windows on identical-transcript retries',async()=>{
 const f=await fixture(1);
 try{
  const first=await f.claim();
  await runMinutesPipeline(f.repo,f.record.id,first,{...config,LLM_REASONING_EFFORT:'low'},async job=>summarize(job));
  await f.repo.change(f.record.id,r=>{r.jobs.find(job=>job.id===first.id).status='failed';});
  const next=await f.claim();let calls=0;
  const result=await runMinutesPipeline(f.repo,f.record.id,next,{...config,LLM_REASONING_EFFORT:'high'},async job=>{calls++;return summarize(job);});
  assert.ok(calls>0,'new reasoning strength must reach the provider');assert.equal(result.coverage.reused,0);
  const policies=['auto','default','low','high','max'].map(effort=>buildMinutesManifest(next,{...config,LLM_REASONING_EFFORT:effort}).policy);
  assert.equal(new Set(policies).size,policies.length);
 }finally{await f.close();}
});

test('live windows retain semantic consolidation and final evidence',async()=>{
 const f=await fixture(18);try{
  let claim;await f.repo.change(f.record.id,r=>{r.capture='recording';r.segments.at(-1).text+=' FACT:最后日期待确认';const job=requestMinutes(r,{scope:'live',modelVersion:'fixture-model'});job.status='running';job.fence='live-efficiency';job.lease=Date.now()+300000;claim=structuredClone(job);});
  const calls=[];const result=await runMinutesPipeline(f.repo,f.record.id,claim,{},async job=>{calls.push(job);return summarize(job);});
  assert.ok(result.coverage.windows>1);assert.ok(calls.length>result.coverage.windows);
  assert.ok(calls.some(job=>job.summaries));
  const refs=result.sections.flatMap(section=>section.items.flatMap(item=>item.evidence));
  assert.ok(refs.some(ref=>ref.segmentId==='s-0'));assert.ok(refs.some(ref=>ref.segmentId==='s-17'));
 }finally{await f.close();}
});

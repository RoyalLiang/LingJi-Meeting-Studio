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
          completionOrder.push(job.snapshot[0].id);
          return {title:'window',sections:[{heading:'window',items:[{text:job.snapshot[0].id,evidence:[{segmentId:job.snapshot[0].id,revision:1}]}]}],actions:[],usageTokens:10};
        }
        assert.deepEqual(job.summaries.map(summary=>summary.sections[0].items[0].text),manifest.windows.map(window=>window.snapshot[0].id));
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

test('rolling live snapshots reuse unchanged middle windows when one confirmed segment arrives', async t => {
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
    assert.equal(first.snapshot.length,120);assert.equal(next.snapshot.length,120);
    assert.equal(next.snapshot[0].id,'s-41');
    assert.ok(generatedWindows<=2,`only rolling boundary windows should regenerate, got ${generatedWindows}`);
    assert.ok(result.coverage.reused>=previous.coverage.windows-2);
    t.diagnostic(JSON.stringify({initialCalls:previous.coverage.calls,rollingCalls:result.coverage.calls,generatedWindows,reused:result.coverage.reused}));
    validateMinutes(result,next.snapshot);
    await f.repo.change(f.record.id,r=>commitMinutes(r,next.id,result,next.fence));
    const record=await f.repo.get(f.record.id);
    assert.equal(record.liveMinutes.transcriptRevision,2);
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
    run=runMinutesPipeline(f.repo,f.record.id,claim,config,async job=>{
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
      const result=await generateMinutes({scope:'live',template:'meeting',snapshot,stage,summaries:stage?[response,response]:undefined},env);
      assert.equal(result.topics[0].id,'t1');assert.equal(result.tables[0].topicId,'t1');validateMinutes(result,snapshot);
      const prompt=request.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n');
      assert.ok(prompt.includes('topics:[{id:string'));
      assert.ok(prompt.includes('topicId:string'));
      assert.ok(prompt.includes('每张表必须完整归属一个主题'));
      assert.ok(prompt.includes('每行仍须引用给定原始片段 ID 与 revision'));
      if(stage)assert.ok(prompt.includes('重新分配唯一主题 id'));
    }
  } finally {globalThis.fetch=original;}
});

test('old completed v2 jobs do not block explicit v3 requests, while new requests remain idempotent', async () => {
  const f=await fixture(2);
  try {
    let oldId,newId;
    await f.repo.change(f.record.id,r=>{
      const previous=requestMinutes(r,{modelVersion:'fixture-model'});oldId=previous.id;
      previous.key=previous.key.replace(':v3:',':v2:');previous.status='completed';previous.snapshot=[];
      r.minutes={...summarize({snapshot:r.segments}),revision:1,edited:true};r.minutesRevision=1;
      r.autoMinutes={enabled:true,lastRevision:r.transcriptRevision,lastScope:'final',intervalSeconds:30};
      assert.equal(queueAutomaticMinutes(r,'fixture-model'),undefined,'format upgrades must not auto-replace an edited minutes version');
      const current=requestMinutes(r,{modelVersion:'fixture-model'});newId=current.id;
      assert.notEqual(newId,oldId);assert.ok(current.key.includes(':v3:'));
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

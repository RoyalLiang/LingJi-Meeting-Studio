import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecord,requestMinutes,commitMinutes} from '../packages/records/src/record.mjs';
import {runMinutesPipeline} from '../services/records/src/minutes-pipeline.mjs';

const config={LLM_MODEL:'fixture-model',LLM_API_URL:'http://fixture.invalid'};
function fixture(scope,count=600){
 const record=createRecord('synthetic-owner');
 record.capture=scope==='live'?'recording':'completed';record.transcription='completed';record.transcriptRevision=1;
 record.segments=Array.from({length:count},(_,i)=>({id:`s-${i}`,revision:1,sourceId:'mic',startMs:i*1000,endMs:(i+1)*1000,text:`合成议题${i}：保留条件与原始引用。`}));
 const repo={async change(_id,change){return change(record);}};
 const claim=()=>{const job=requestMinutes(record,{scope,modelVersion:'fixture-model',retry:true});job.status='running';job.fence=job.id;job.lease=Date.now()+300000;return structuredClone(job);};
 return {record,repo,claim};
}
function summarize(job){
 const source=job.snapshot.find(segment=>!segment.contextOnly);
 const items=job.summaries?job.summaries.flatMap(summary=>summary.sections.flatMap(section=>section.items)):[{text:source.text,evidence:[{segmentId:source.id,revision:source.revision}]}];
 return {title:'合成议题汇总',sections:[{heading:'合成议题',items}],actions:[]};
}

test('live pipeline checks frozen revisions with linear source reads on a long meeting',async t=>{
 const f=fixture('live'),claim=f.claim();let reads=0;
 for(const segment of f.record.segments){const id=segment.id;Object.defineProperty(segment,'id',{enumerable:true,get(){reads++;return id;}});}
 const result=await runMinutesPipeline(f.repo,f.record.id,claim,config,summarize);
 t.diagnostic(JSON.stringify({segments:f.record.segments.length,windows:result.coverage.windows,sourceIdReads:reads}));
 assert.ok(reads<f.record.segments.length*80,`snapshot guards scanned source IDs ${reads} times`);
 assert.equal(result.coverage.completed,result.coverage.windows);
});

test('reused validated windows advance displayed progress without new provider calls',async()=>{
 const f=fixture('final'),first=f.claim();
 const result=await runMinutesPipeline(f.repo,f.record.id,first,config,summarize);
 commitMinutes(f.record,first.id,result,first.fence);
 const next=f.claim();
 const reused=await runMinutesPipeline(f.repo,f.record.id,next,config,()=>assert.fail('unchanged windows must reuse the validated cache'));
 assert.ok(reused.coverage.reused>0);
 const job=f.record.jobs.find(job=>job.id===next.id);
 assert.equal(job.progress.completed,job.progress.total);
});

test('final synthesis is visible before the provider finishes merging nodes',async()=>{
 const f=fixture('final'),claim=f.claim();let synthesis=false;
 await runMinutesPipeline(f.repo,f.record.id,claim,config,job=>{
  if(job.stage==='synthesis'){
   synthesis=true;
   const progress=f.record.jobs.find(entry=>entry.id===claim.id).progress;
   assert.equal(progress.completed,progress.total);
   assert.equal(progress.stage,'synthesis');
  }
  return summarize(job);
 });
 assert.ok(synthesis);
});

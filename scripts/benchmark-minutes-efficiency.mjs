import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runMinutesPipeline} from '../services/records/src/minutes-pipeline.mjs';
import {createRecord,requestMinutes} from '../packages/records/src/record.mjs';
import {buildMinutesManifest} from '../services/records/src/minutes-pipeline.mjs';
import {compactMinutesPayload} from '../services/records/src/minutes-wire.mjs';

export async function benchmarkMinutesEfficiency(){
 const snapshot=Array.from({length:300},(_,index)=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,revision:1,sourceId:`10000000-0000-4000-8000-${String(index%2).padStart(12,'0')}`,speakerId:`20000000-0000-4000-8000-${String(index%3).padStart(12,'0')}`,speaker:`发言人${index%3+1}`,startMs:index*10000,endMs:(index+1)*10000,text:`议题${index}：本轮只确认测试范围；只有评审通过才能推进，不承诺周五上线，负责人和时间继续待确认。`}));
 const items=snapshot.map(segment=>({text:segment.text,evidence:[{segmentId:segment.id,revision:segment.revision}]}));
 const summaries=[{title:'虚构项目评审',sections:[{heading:'条件与跟进',items}],actions:[]}];
 const job={snapshot,notes:'所有条件、否定、负责人和日期保留原意。',summaries};
 const before={transcript:snapshot,notes:job.notes,summaries},wire=compactMinutesPayload(job);
 const output={title:'虚构项目评审',sections:[{heading:'条件与跟进',items:wire.payload.transcript.map((segment,index)=>({text:items[index].text,evidence:[segment.id]}))}],actions:[]};
 const restored=wire.restore(output);assert.deepEqual(restored.sections[0].items,items);assert.equal(wire.payload.transcript.length,300);
 snapshot.forEach((segment,index)=>assert.equal(wire.payload.transcript[index].text,segment.text));
 const oldBuckets=new Map();for(const segment of snapshot){const key=Math.floor(segment.startMs/120000);oldBuckets.set(key,[...(oldBuckets.get(key)||[]),segment]);}
 for(const batch of oldBuckets.values())assert.ok(Buffer.byteLength(JSON.stringify({transcript:batch,notes:job.notes}))<24000);
 const currentWindows=buildMinutesManifest({...job,scope:'final'}).windows.length;
 const bytes=value=>Buffer.byteLength(JSON.stringify(value));
 const input={before:bytes(before),after:bytes(wire.payload)},outputBytes={before:bytes(restored),after:bytes(output)};
 // shortcut: the old orchestration uses current domain guards; use archived builds for historical runtime comparisons.
 const baselineSource=execFileSync('git',['show','v0.1.35:services/records/src/minutes-pipeline.mjs'],{encoding:'utf8'}).replace(/from ['"]([^'"]+)['"]/g,(_match,specifier)=>'from '+JSON.stringify(new URL(specifier,new URL('../services/records/src/minutes-pipeline.mjs',import.meta.url)).href));
 const baseline=await import('data:text/javascript;base64,'+Buffer.from(baselineSource).toString('base64'));
 async function replay(run,compact){
  const record=createRecord('synthetic-owner');record.capture='completed';record.transcription='completed';record.transcriptRevision=1;record.segments=structuredClone(snapshot);
  const claim=requestMinutes(record,{scope:'final',modelVersion:'fixture-model'});claim.status='running';claim.fence='benchmark';claim.lease=Date.now()+300000;
  const repo={async change(_id,change){return change(record);}};let calls=0,payloadBytes=0;
  let result;try{result=await run(repo,record.id,structuredClone(claim),{},async job=>{
   calls++;const payload=compact?compactMinutesPayload(job).payload:{transcript:job.snapshot,notes:job.notes,context:job.liveContext,summaries:job.summaries,stage:job.stage,omittedEvidence:job.omittedEvidence};
   payloadBytes+=bytes(payload);
   const facts=job.summaries?job.summaries.flatMap(summary=>summary.sections.flatMap(section=>section.items)):job.snapshot.filter(segment=>!segment.contextOnly).map(segment=>({text:segment.text,evidence:[{segmentId:segment.id,revision:segment.revision}]}));
   const sections=[];for(let i=0;i<facts.length;i+=100)sections.push({heading:`讨论${i/100+1}`,items:facts.slice(i,i+100)});
   return {title:'合成会议',sections,actions:[],decisions:[],usageReported:false};
  });
  }catch(error){return {ok:false,stubbedModelCalls:calls,payloadBytes,error:error.code||error.name};}
  const facts=result.sections.flatMap(section=>section.items);assert.equal(facts.length,300);
  const byId=new Map(facts.map(item=>[item.evidence[0].segmentId,item]));for(const segment of snapshot){assert.equal(byId.get(segment.id).text,segment.text);assert.equal(byId.get(segment.id).evidence[0].revision,segment.revision);}
  return {ok:true,stubbedModelCalls:calls,windows:result.coverage.windows,payloadBytes,all300FactsPreserved:true};
 }
 const pipeline={baseline:await replay(baseline.runMinutesPipeline,false),current:await replay(runMinutesPipeline,true)};assert.equal(pipeline.current.ok,true,JSON.stringify(pipeline.current));
 return {fixture:'synthetic-50-minutes-300-segments',segments:300,durationMinutes:50,allSourceTextPreserved:true,allCitationsRestored:true,inputBytes:input,outputBytes,inputReduction:1-input.after/input.before,outputReduction:1-outputBytes.after/outputBytes.before,providerTokensMeasured:false,pipeline,textWindows:{before:oldBuckets.size,after:currentWindows,audioWindowMs:120000,textWindowMs:300000}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await benchmarkMinutesEfficiency(),null,2));}
 catch(error){console.error('Minutes benchmark failed:',error.code||error.message);process.exitCode=1;}
}

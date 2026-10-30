import { minutesDiscussionItems as discussionItems, minutesTextChunks } from '../../../packages/records/src/minutes-quality.mjs';
import { minutesTimeoutMs } from './minutes-deadline.mjs';
import { MINUTES_PROMPT_VERSION } from './minutes-prompts.mjs';
import { audioMinutesEnabled } from './config.mjs';
import { liveBaseline, mergeLiveMinutes } from '../../../packages/records/src/live-minutes.mjs';
import { ruleIntents } from '../../../packages/records/src/intents.mjs';
import { telemetry } from './telemetry.mjs';
import { createHash } from 'node:crypto';
import {compactMinutesPayload} from './minutes-wire.mjs';
import { requireThat, validateMinutes, emit } from '../../../packages/records/src/record.mjs';
import { meteredMinutesCall } from './minutes-usage.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const size = value => Buffer.byteLength(JSON.stringify(value));
const inputBudget=config=>Math.max(4096,Math.min(96000,Number(config.RECORD_MINUTES_INPUT_BYTES)||24000));
const synthesisBudget=config=>{
  const value=Number(config.RECORD_MINUTES_SYNTHESIS_INPUT_BYTES);
  return Math.max(4096,Math.min(96000,Number.isFinite(value)&&value>0?Math.floor(value):96000));
};
const windowConcurrency=config=>{
  const value=Number(config.RECORD_MINUTES_WINDOW_CONCURRENCY);
  return Number.isFinite(value)&&value>=1?Math.min(4,Math.floor(value)):2;
};
const content = result => Object.fromEntries(Object.entries(result).filter(([key]) => !['runtime','usageTokens','tokenUsage','usageReported','coverage'].includes(key)));
const refs = result => {
  const found=new Map();
  function visit(value){if(!value||typeof value!=='object')return;if(typeof value.segmentId==='string'&&Number.isInteger(value.revision))found.set(`${value.segmentId}:${value.revision}`,value);for(const child of Object.values(value))visit(child);}
  visit(result);return [...found.values()];
};
export function buildMinutesManifest(job,config={},budget=inputBudget(config)){
  const windowMs=audioMinutesEnabled(config)?120000:300000;
  const policy=hash({version:MINUTES_PROMPT_VERSION,minutesMode:config.MINUTES_MODE,realtimeModel:config.OPENAI_REALTIME_MODEL,realtimeUrl:config.OPENAI_REALTIME_URL,windowMs,budget,structuredOutputs:config.LLM_STRUCTURED_OUTPUTS,reasoningEffort:config.LLM_REASONING_EFFORT||'auto',context:job.liveContext,model:job.modelVersion==='default'?config.LLM_MODEL:job.modelVersion,base:config.LLM_API_URL,protocol:config.LLM_PROTOCOL,template:job.template,scope:job.scope,mode:job.mode,notes:job.notes,notesRevision:job.notesRevision,generation:job.generation});
  const windows=[];let current=[];
  const flush=()=>{if(current.length){windows.push({key:hash({policy,snapshot:current}),snapshot:current});current=[];}};
  function add(segment){
    if(size({transcript:[segment],notes:job.notes,context:job.liveContext})>budget){
      requireThat(segment.text?.length>1,'minutes_input_metadata_too_large',422);
      const first=minutesTextChunks(segment.text,Math.ceil(segment.text.length/2))[0];add({...segment,text:first});add({...segment,text:segment.text.slice(first.length)});return;
    }
    if(current.length && size({transcript:[...current,segment],notes:job.notes,context:job.liveContext})>budget)flush();current.push(segment);
  }
  const snapshot=job.snapshot.map(({id,revision,text,sourceId,speakerId,speaker,speakerName,startMs,endMs,contextOnly})=>({id,revision,text,sourceId,speakerId,speaker,speakerName,startMs,endMs,contextOnly})).sort((a,b)=>(a.startMs||0)-(b.startMs||0)||(a.endMs||0)-(b.endMs||0));
  if (audioMinutesEnabled(config)) {
    // Group by source before timeline buckets: simultaneous tracks count as
    // separate audio. Split long ASR turns without inventing new transcript IDs.
    const slices = snapshot.flatMap(segment => {
      if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs - segment.startMs <= 120000) return [segment];
      const parts = [];
      for (let startMs = segment.startMs; startMs < segment.endMs; startMs += 120000) parts.push({...segment,startMs,endMs:Math.min(startMs+120000,segment.endMs)});
      return parts;
    }).sort((a,b) => String(a.sourceId).localeCompare(String(b.sourceId)) || a.startMs-b.startMs);
    snapshot.splice(0,snapshot.length,...slices);
  }
  const snapshotOffset=Number.isSafeInteger(job.snapshotOffset)&&job.snapshotOffset>=0?job.snapshotOffset:0;
  const single=size({transcript:snapshot,notes:job.notes,context:job.liveContext})<=budget;
  let bucket;
  snapshot.forEach((segment,index)=>{
    const timed=Number.isFinite(segment.startMs)&&Number.isFinite(segment.endMs)&&segment.endMs>segment.startMs;
    const next=timed?Math.floor(segment.startMs/windowMs):undefined;
    if(current.length && (timed ? next!==bucket || (audioMinutesEnabled(config) && current[0].sourceId !== segment.sourceId) : !single && (index+snapshotOffset)%24===0))flush();
    bucket=next;add(segment);
  });flush();
  if(job.scope==='live'&&snapshot.some(segment=>segment.contextOnly!==true)){
    for(let index=windows.length-1;index>=0;index--)if(windows[index].snapshot.every(segment=>segment.contextOnly===true))windows.splice(index,1);
  }
  const primaryWindows=windows.map(window=>[...window.snapshot]);
  if(!audioMinutesEnabled(config))for(let index=0;index<windows.length;index++){
    const window=windows[index], adjacent=[primaryWindows[index-1]?.at(-1),primaryWindows[index+1]?.[0]].filter(Boolean);
    for(const neighbor of adjacent){
      if(window.snapshot.some(segment=>segment.id===neighbor.id&&segment.revision===neighbor.revision))continue;
      const candidate=[...window.snapshot,{...neighbor,contextOnly:job.scope==='live'}].sort((a,b)=>(a.startMs||0)-(b.startMs||0));
      if(size({transcript:candidate,notes:job.notes,context:job.liveContext})<=budget)window.snapshot=candidate;
    }
    window.key=hash({policy,snapshot:window.snapshot});
  }
  requireThat(windows.length>0 && windows.length<=512,'minutes_window_limit',422);
  return {version:1,budget,synthesisBudget:synthesisBudget(config),policy,generation:job.generation,transcriptRevision:job.transcriptRevision,notesRevision:job.notesRevision,snapshotOffset,hash:job.manifestHash,windows};
}

function keepWindowDiscussion(result,leaves,snapshot,windows){
  const itemKey=item=>JSON.stringify([item.heading,item.text.trim().replace(/\s+/g,' '),item.evidence.map(ref=>`${ref.segmentId}:${ref.revision}`).sort()]);
  const known=new Set(discussionItems(result).map(itemKey)),groups=new Map();
  for(const leaf of leaves)for(const item of discussionItems(leaf.result)){
    const key=itemKey(item);if(known.has(key))continue;known.add(key);
    const exact=(result.topics||[]).filter(topic=>topic.title===item.heading);
    const topic=exact.length===1?exact[0]:undefined;
    const title=topic?.title||`讨论过程 · ${item.heading}`,heading=minutesTextChunks(title,200)[0],items=groups.get(heading)||[];
    const context=title.length>200?`${item.heading}：`:'',step=7900-context.length;
    // Historical proposals remain readable without becoming current decisions.
    for(const text of minutesTextChunks(item.text,step))items.push({text:context+text,evidence:item.evidence,kind:'fact',label:'过程记录',...(topic?.id?{topicId:topic.id}:{})});groups.set(heading,items);
  }
  const sections=[...result.sections],corrections=new Map(),windowSources=new Map(windows.map(window=>[window.key,window.snapshot]));
  for(const source of [...leaves.map(leaf=>({minutes:leaf.result,snapshot:windowSources.get(leaf.key)})),{minutes:result,snapshot}]){
    const ends=new Map(source.snapshot.filter(segment=>!segment.contextOnly).map(segment=>[`${segment.id}:${segment.revision}`,segment.endMs||0]));
    for(const correction of source.minutes.corrections||[]){
      const time=Math.max(0,...correction.evidence.map(ref=>ends.get(`${ref.segmentId}:${ref.revision}`)||0)),old=corrections.get(correction.targetId);
      if(!old||time>=old.time)corrections.set(correction.targetId,{time,correction});
    }
  }
  for(const [heading,items] of groups)for(let i=0;i<items.length;i+=100)sections.push({heading,items:items.slice(i,i+100)});
  return {...result,sections,decisions:result.decisions||[],actions:result.actions||[],corrections:[...corrections.values()].map(entry=>entry.correction)};
}

function currentJob(record,claim){
  const job=record.jobs.find(j=>j.id===claim.id);
  requireThat(job && !record.deleted && record.generation===claim.generation && job.fence===claim.fence && job.status==='running','stale_job',410);
  const liveAdvanced=claim.scope==='live' && record.liveMinutes?.transcriptRevision>claim.transcriptRevision;
  const baselineChanged=claim.scope==='live' && claim.liveBaseHash && hash(record.liveMinutes || null)!==claim.liveBaseHash;
  const changed=claim.scope==='live' ? claim.snapshot.some(s=>!record.segments.some(current=>current.id===s.id&&current.revision===s.revision)) : record.transcriptRevision!==claim.transcriptRevision;
  requireThat(!liveAdvanced && !baselineChanged && !(claim.liveIncremental && !liveBaseline(record)) && !changed && record.notesRevision===claim.notesRevision && record.minutesRevision===claim.baseMinutesRevision,'minutes_snapshot_changed',409);
  return job;
}
export async function runMinutesPipeline(repo,recordId,claim,config,generate,options={}){
  const manifest=buildMinutesManifest(claim,config),cache=new Map(),inFlight=new Map(), completedWindows=new Map();let tokens=0,calls=0,reused=0,previewKey;
  async function mapWindows(items,execute){
    const results=new Array(items.length);let next=0,failure,failed=false;
    // Keep input order, stop scheduling on failure, and drain every in-flight call
    // before the worker can release this job's fence or begin a retry.
    await Promise.all(Array.from({length:Math.min(windowConcurrency(config),items.length)},async()=>{
      while(next<items.length && !failed){
        const index=next++;
        try{results[index]=await execute(items[index]);}catch(error){if(!failed){failure=error;failed=true;}}
      }
    }));
    if(failed)throw failure;
    return results;
  }
  await repo.change(recordId,record=>{
    const job=currentJob(record,claim);
    for(const previous of record.jobs)for(const entry of previous.windowCache||[])if(entry.policy===manifest.policy)cache.set(entry.key,entry.result);
    job.manifest={...manifest,windows:manifest.windows.map(({key,snapshot})=>({key,refs:snapshot.map(({id,revision})=>({segmentId:id,revision})),chars:JSON.stringify(snapshot).length}))};
    job.progress={completed:0,total:manifest.windows.length,stage:'windows'};
  });
  async function execute(key,input,stage,preview=false){
    await repo.change(recordId,record=>{const job=currentJob(record,claim);job.lease=Date.now()+(minutesTimeoutMs(claim)+60000);});
    let result=cache.get(key);
    if(result){validateMinutes(result,claim.snapshot,claim.liveContext,{newEvidenceOnly:true});reused++;}
    else if(inFlight.has(key)){result=await inFlight.get(key);reused++;}
    else{
      const pending=(async()=>{
      let first=false;
      const allowed = new Map(input.snapshot.map(segment=>[`${segment.id}:${segment.revision}`,segment]));
      const validationSnapshot=claim.snapshot.filter(segment=>allowed.has(`${segment.id}:${segment.revision}`)).map(segment=>({...segment,contextOnly:allowed.get(`${segment.id}:${segment.revision}`).contextOnly}));
      const result=await telemetry.measure('minutes.window',{recordId,jobId:claim.id},()=>meteredMinutesCall(repo,recordId,claim,generate,{...claim,...input,validationSnapshot},config,stage==='single'||preview?options:{onDelta:(delta,runtime)=>{if(!first){first=true;telemetry.event('minutes.first-text',{recordId,jobId:claim.id,durationMs:runtime?.firstTokenMs});}if(claim.scope==='live' && stage==='window' && (previewKey===undefined || previewKey===key)){previewKey=key;return options.onDelta?.(delta,runtime,key);}}}));
      telemetry.event('minutes.window-usage',{recordId,jobId:claim.id,tokens:result.usageTokens,firstTextMs:result.runtime?.firstTokenMs});
      validateMinutes(result,validationSnapshot,claim.liveContext,{newEvidenceOnly:true});validateMinutes(result,claim.snapshot,claim.liveContext,{newEvidenceOnly:true});
      tokens+=Number.isSafeInteger(result.usageTokens)&&result.usageTokens>=0?result.usageTokens:0;calls++;
      return result;
      })();
      inFlight.set(key,pending);result=await pending;
    }
    await repo.change(recordId,record=>{
      const job=currentJob(record,claim);job.windowCache ||= [];
      if(!job.windowCache.some(entry=>entry.key===key))job.windowCache.push({key,policy:manifest.policy,result});
      if(stage==='window'||stage==='single') {
        job.progress.completed++;
        if (claim.scope === 'live') {
          const ids = new Set(input.snapshot.map(segment=>`${segment.id}:${segment.revision}`));
          completedWindows.set(key, {result, snapshot:claim.snapshot.filter(segment=>ids.has(`${segment.id}:${segment.revision}`))});
          let partial = liveBaseline(record);
      const baselineParts = new Set((partial?.evidenceSnapshot || []).map(segment=>`${segment.id}:${segment.revision}`)).size;
          for (const entry of manifest.windows) {const window=completedWindows.get(entry.key);if(window)partial = mergeLiveMinutes(partial, window.result, window.snapshot);}
      validateMinutes(partial, partial.evidenceSnapshot,undefined,{aggregate:true,aggregateParts:baselineParts+completedWindows.size,maxSections:Math.min(25650,(liveBaseline(record)?.sections.length||0)+20*manifest.windows.length+1)});
          job.partialMinutes = {...partial, transcriptRevision:claim.transcriptRevision, generatedAt:new Date().toISOString()};
        }
      }
      job.progress.stage=stage;job.lease=Date.now()+(minutesTimeoutMs(claim)+60000);emit(record,'minutes.progress',{jobId:job.id,completed:job.progress.completed,total:job.progress.total,stage});
    });
    cache.set(key,result);return {key,result};
  }
  let nodes=await mapWindows(manifest.windows,window=>execute(window.key,{snapshot:window.snapshot},manifest.windows.length===1?'single':'window'));
  const leaves=nodes;
  if(claim.mode==='extractive'&&leaves.length>1)nodes=[{key:manifest.hash,result:{title:'本地提取纪要',method:'extractive',sections:leaves.flatMap(node=>node.result.sections),actions:ruleIntents(claim.snapshot.filter(segment=>!segment.contextOnly)).items.filter(item=>item.kind==='action').map(({text,evidence})=>({text,evidence,owner:null,due:null}))}}];
  let level=0;
  while(nodes.length>1){
    const groups=[];let group=[];
    const inputFor=items=>{
      const wanted=new Set(items.flatMap(node=>refs(node.result).map(ref=>`${ref.segmentId}:${ref.revision}`)));
      const sources=claim.snapshot.filter(s=>wanted.has(`${s.id}:${s.revision}`));
      const input={snapshot:sources.map(({id,revision,speakerId,speaker,speakerName,sourceId,startMs,endMs,contextOnly})=>({id,revision,speakerId,speaker,speakerName,sourceId,startMs,endMs,contextOnly,textOmitted:true})),summaries:items.map(node=>content(node.result)),stage:'synthesis',omittedEvidence:0};
      let remaining=Math.min(24000,Math.max(0,manifest.synthesisBudget-Buffer.byteLength(payloadFor(input))-1024));
      const critical=new Set(items.flatMap(node=>refs({corrections:node.result.corrections,decisions:node.result.decisions,actions:node.result.actions})).map(ref=>`${ref.segmentId}:${ref.revision}`));
      const order=sources.map((source,index)=>({source,index})).sort((a,b)=>Number(critical.has(`${b.source.id}:${b.source.revision}`))-Number(critical.has(`${a.source.id}:${a.source.revision}`))||(b.source.endMs||0)-(a.source.endMs||0));
      for(const {index} of order){
        const text=sources[index].text, bytes=size(text||'')+10;
        if(typeof text==='string'&&bytes<=remaining){input.snapshot[index].text=text;delete input.snapshot[index].textOmitted;remaining-=bytes;}
        else {input.snapshot[index].textOmitted=true;input.omittedEvidence++;}
      }
      return input;
    };
    const payloadFor=input=>JSON.stringify(audioMinutesEnabled(config)||claim.mode==='extractive'?{transcript:input.snapshot,notes:claim.notes,context:claim.liveContext,summaries:input.summaries,stage:input.stage,omittedEvidence:input.omittedEvidence}:compactMinutesPayload({...claim,...input}).payload);
    for(const node of nodes){
      if(group.length && (group.length>=8 || Buffer.byteLength(payloadFor(inputFor([...group,node])))>manifest.synthesisBudget)){groups.push(group);group=[];}
      group.push(node);
    }if(group.length)groups.push(group);
    requireThat(groups.length<nodes.length && ++level<=16,'minutes_intermediate_too_large',422);
    nodes=await mapWindows(groups,async children=>{
      if(children.length===1)return children[0];
      const input=inputFor(children),payload=payloadFor(input);requireThat(payload.length<180000 && Buffer.byteLength(payload)<=manifest.synthesisBudget,'minutes_intermediate_too_large',422);
      return execute(hash({policy:manifest.policy,children:children.map(node=>node.key),synthesisBudget:manifest.synthesisBudget}),input,'synthesis',groups.length===1);
    });
  }
  const result=manifest.windows.length>1&&claim.mode!=='extractive'?keepWindowDiscussion(nodes[0].result,leaves,claim.snapshot,manifest.windows):nodes[0].result;
  validateMinutes(result,claim.snapshot,claim.liveContext,{newEvidenceOnly:true,maxSections:manifest.windows.length>1?50*(manifest.windows.length+1):undefined});
  return {...result,usageTokens:tokens,usageRecorded:true,coverage:{manifestHash:manifest.hash,windows:manifest.windows.length,completed:manifest.windows.length,segments:new Set(claim.snapshot.map(s=>s.id)).size,calls,reused,levels:level},runtime:{...result.runtime,pipelineCalls:calls}};
}

import { telemetry } from './telemetry.mjs';
import { createHash } from 'node:crypto';
import { requireThat, validateMinutes, emit } from '../../../packages/records/src/record.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const size = value => Buffer.byteLength(JSON.stringify(value));
const inputBudget=config=>Math.max(4096,Math.min(96000,Number(config.RECORD_MINUTES_INPUT_BYTES)||24000));
const content = result => Object.fromEntries(Object.entries(result).filter(([key]) => !['runtime','usageTokens','coverage'].includes(key)));
const refs = result => {
  const found=new Map();
  function visit(value){if(!value||typeof value!=='object')return;if(typeof value.segmentId==='string'&&Number.isInteger(value.revision))found.set(`${value.segmentId}:${value.revision}`,value);for(const child of Object.values(value))visit(child);}
  visit(result);return [...found.values()];
};
export function buildMinutesManifest(job,config={},budget=inputBudget(config)){
  const policy=hash({version:1,budget,model:job.modelVersion==='default'?config.LLM_MODEL:job.modelVersion,base:config.LLM_API_URL,protocol:config.LLM_PROTOCOL,template:job.template,scope:job.scope,mode:job.mode,notes:job.notes,notesRevision:job.notesRevision,generation:job.generation});
  const windows=[];let current=[];
  const flush=()=>{if(current.length){windows.push({key:hash({policy,snapshot:current}),snapshot:current});current=[];}};
  function add(segment){
    if(size({transcript:[segment],notes:job.notes})>budget){
      requireThat(segment.text?.length>1,'minutes_input_metadata_too_large',422);
      const middle=Math.ceil(segment.text.length/2);add({...segment,text:segment.text.slice(0,middle)});add({...segment,text:segment.text.slice(middle)});return;
    }
    if(current.length && size({transcript:[...current,segment],notes:job.notes})>budget)flush();current.push(segment);
  }
  const snapshot=job.snapshot.map(({id,revision,text,sourceId,speakerId,speaker,speakerName,startMs,endMs})=>({id,revision,text,sourceId,speakerId,speaker,speakerName,startMs,endMs}));
  const single=size({transcript:snapshot,notes:job.notes})<=budget;
  snapshot.forEach((segment,index)=>{if(!single && index%24===0)flush();add(segment);});flush();
  requireThat(windows.length>0 && windows.length<=512,'minutes_window_limit',422);
  return {version:1,budget,policy,generation:job.generation,transcriptRevision:job.transcriptRevision,notesRevision:job.notesRevision,hash:job.manifestHash,windows};
}
function currentJob(record,claim){
  const job=record.jobs.find(j=>j.id===claim.id);
  requireThat(job && !record.deleted && record.generation===claim.generation && job.fence===claim.fence && job.status==='running','stale_job',410);
  const changed=claim.scope==='live' ? claim.snapshot.some(s=>!record.segments.some(current=>current.id===s.id&&current.revision===s.revision)) : record.transcriptRevision!==claim.transcriptRevision;
  requireThat(!changed && record.notesRevision===claim.notesRevision && record.minutesRevision===claim.baseMinutesRevision,'minutes_snapshot_changed',409);
  return job;
}
export async function runMinutesPipeline(repo,recordId,claim,config,generate,options={}){
  const manifest=buildMinutesManifest(claim,config),cache=new Map();let tokens=0,calls=0,reused=0;
  await repo.change(recordId,record=>{
    const job=currentJob(record,claim);
    for(const previous of record.jobs)for(const entry of previous.windowCache||[])if(entry.policy===manifest.policy)cache.set(entry.key,entry.result);
    job.manifest={...manifest,windows:manifest.windows.map(({key,snapshot})=>({key,refs:snapshot.map(({id,revision})=>({segmentId:id,revision})),chars:JSON.stringify(snapshot).length}))};
    job.progress={completed:0,total:manifest.windows.length,stage:'windows'};
  });
  async function execute(key,input,stage,preview=false){
    await repo.change(recordId,record=>{const job=currentJob(record,claim);job.lease=Date.now()+(claim.scope==='live'?180000:300000);});
    let result=cache.get(key);const cached=!!result;
    if(result){validateMinutes(result,claim.snapshot);reused++;}
    else{
      let first=false;
      result=await telemetry.measure('minutes.window',{recordId,jobId:claim.id},()=>generate({...claim,...input},config,stage==='single'||preview?options:{onDelta:(delta,runtime)=>{if(!first){first=true;telemetry.event('minutes.first-text',{recordId,jobId:claim.id,durationMs:runtime?.firstTokenMs});}}}));
      telemetry.event('minutes.window-usage',{recordId,jobId:claim.id,tokens:result.usageTokens,firstTextMs:result.runtime?.firstTokenMs});
      validateMinutes(result,input.snapshot);validateMinutes(result,claim.snapshot);
      tokens+=Number.isSafeInteger(result.usageTokens)&&result.usageTokens>=0?result.usageTokens:0;calls++;
    }
    await repo.change(recordId,record=>{
      const job=currentJob(record,claim);job.windowCache ||= [];
      if(!job.windowCache.some(entry=>entry.key===key)){job.windowCache.push({key,policy:manifest.policy,result});if(!cached){const used=Number.isSafeInteger(result.usageTokens)&&result.usageTokens>=0?result.usageTokens:0;record.usage.llmTokens+=used;job.pipelineUsageTokens=(job.pipelineUsageTokens||0)+used;}}
      if(stage==='window'||stage==='single')job.progress.completed++;
      job.progress.stage=stage;job.lease=Date.now()+(claim.scope==='live'?180000:300000);emit(record,'minutes.progress',{jobId:job.id,completed:job.progress.completed,total:job.progress.total,stage});
    });
    cache.set(key,result);return {key,result};
  }
  let nodes=[];
  for(const window of manifest.windows)nodes.push(await execute(window.key,{snapshot:window.snapshot},manifest.windows.length===1?'single':'window'));
  let level=0;
  while(nodes.length>1){
    const groups=[];let group=[];
    const inputFor=items=>{
      const wanted=new Set(items.flatMap(node=>refs(node.result).map(ref=>`${ref.segmentId}:${ref.revision}`)));
      return {snapshot:claim.snapshot.filter(s=>wanted.has(`${s.id}:${s.revision}`)).map(({id,revision,speakerId,speaker,speakerName,sourceId})=>({id,revision,speakerId,speaker,speakerName,sourceId})),summaries:items.map(node=>content(node.result)),stage:'synthesis'};
    };
    for(const node of nodes){
      if(group.length && (group.length>=8 || size({...inputFor([...group,node]),notes:claim.notes})>manifest.budget)){groups.push(group);group=[];}
      group.push(node);
    }if(group.length)groups.push(group);
    requireThat(groups.length<nodes.length && ++level<=16,'minutes_intermediate_too_large',422);
    const next=[];
    for(const children of groups){
      if(children.length===1){next.push(children[0]);continue;}
      const input=inputFor(children);requireThat(JSON.stringify({...input,notes:claim.notes}).length<=180000 && size({...input,notes:claim.notes})<=manifest.budget,'minutes_intermediate_too_large',422);
      next.push(await execute(hash({policy:manifest.policy,children:children.map(node=>node.key)}),input,'synthesis',groups.length===1));
    }nodes=next;
  }
  return {...nodes[0].result,usageTokens:tokens,usageRecorded:true,coverage:{manifestHash:manifest.hash,windows:manifest.windows.length,completed:manifest.windows.length,segments:new Set(claim.snapshot.map(s=>s.id)).size,calls,reused,levels:level},runtime:{...nodes[0].result.runtime,pipelineCalls:calls}};
}

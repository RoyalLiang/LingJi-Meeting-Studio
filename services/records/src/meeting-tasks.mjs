import { createHash } from 'node:crypto';
import { Harness } from '@earendil-works/pi-durable';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';
import { modelProfile, estimateTask } from './model-profile.mjs';

const kernels=new WeakMap(), digest=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const terminal=new Set(['completed','succeeded','failed','blocked','cancelled','unknown','partial']);
export function taskLedger(metrics){
  const calls=metrics.filter(metric=>['model','compaction'].includes(metric.kind));
  return {rounds:calls.filter(metric=>metric.kind==='model').length,compactions:calls.filter(metric=>metric.kind==='compaction').length,reportedRounds:calls.filter(metric=>metric.usageReported).length,totalTokens:calls.reduce((sum,metric)=>sum+(metric.usage?.totalTokens||0),0),cost:calls.length&&calls.every(metric=>metric.pricingKnown&&metric.usageComplete===true)?calls.reduce((sum,metric)=>sum+(metric.usage?.cost?.total||0),0):null,toolsMs:metrics.filter(metric=>metric.kind==='tool').reduce((sum,metric)=>sum+metric.elapsedMs,0),userWaitMs:metrics.filter(metric=>metric.kind==='user_wait').reduce((sum,metric)=>sum+metric.elapsedMs,0)};
}
export async function openMeetingHarness(repo, storage, options, context) {
  const harness=await Harness.open(storage,options,context);
  if(repo){
    const kernel=meetingTasks(repo),close=harness.close.bind(harness);kernel.own(harness,context);
    harness.close=async(...args)=>{try{return await close(...args);}finally{kernel.disown(harness);}};
  }
  return harness;
}

// One domain seam. Feature adapters retain their versioned checkpoints and
// validators; the kernel owns admission, identity, cancellation and diagnostics.
export function meetingTasks(repo, {maxConcurrent=2, maxPerOwner=2, now=Date.now}={}) {
  if(kernels.has(repo))return kernels.get(repo);
  const adapters=new Map(), handles=new Map(), adopted=new Map(), submissions=new Map(), queue=[], active=new Map();let closing=false,pumping=false;
  const key=(kind,owner,requestId)=>`meeting-task:${digest([kind,owner,requestId])}`;
  async function guard(row){
    requireThat(row?.kind==='meeting-task','meeting_task_not_found',404);
    const access=await repo.getRecordAccess(row.sourceIds);
    requireThat(access.length===row.sourceIds.length&&access.every(source=>source.kind==='record'&&source.owner===row.owner&&!source.deleted&&Date.parse(source.deleteAt)>now()),'agent_source_unavailable',410);
  }
  async function pump(){
    if(pumping||closing)return;pumping=true;
    try {
      if(!queue.length)return;
      for(const item of [...queue])if(item.sourceIds?.length)try{await guard({kind:'meeting-task',owner:item.owner,sourceIds:item.sourceIds});}catch(error){const index=queue.indexOf(item);if(index>=0){queue.splice(index,1);item.reject(error);}}
      const reportWait=async(item,reason)=>{if(item.reason===reason)return;item.reason=reason;try{await item.onWait?.(reason);}catch(error){const index=queue.indexOf(item);if(index>=0){queue.splice(index,1);item.reject(error);}}};
      if(await repo.recordingActive?.()){for(const item of [...queue])await reportWait(item,'recording');return;}
      for(let i=0;i<queue.length&&active.size<maxConcurrent;){
        const item=queue[i];if([...active.values()].filter(value=>value.owner===item.owner).length>=maxPerOwner){i++;continue;}
        queue.splice(i,1);if(item.signal?.aborted){item.reject(item.signal.reason);continue;}
        const token=Symbol();active.set(token,item);
        item.resolve(()=>{active.delete(token);void pump().catch(()=>{});});
      }
      for(const item of [...queue])await reportWait(item,'capacity');
    }finally{pumping=false;}
  }
  const timer=setInterval(()=>void pump().catch(()=>{}),250);timer.unref();
  const kernel={
    own(handle,context){handles.set(handle,context);},
    disown(handle){handles.delete(handle);},
    resources(){return {handles:handles.size,queued:queue.length,active:active.size};},
    register(kind,adapter){
      const previous=adapters.get(kind);adapters.set(kind,adapter);
      return ()=>{if(adapters.get(kind)===adapter){if(previous)adapters.set(kind,previous);else adapters.delete(kind);}};
    },
    async capacity(owner,signal,sourceIds,onWait){
      requireThat(!closing,'agent_runtime_closed',503);signal?.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const item={owner,signal,sourceIds,onWait,resolve:value=>{signal?.removeEventListener('abort',abort);resolve(value);},reject:error=>{signal?.removeEventListener('abort',abort);reject(error);}};
        const abort=()=>{const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);item.reject(signal.reason);};
        signal?.addEventListener('abort',abort,{once:true});queue.push(item);void pump().catch(reject);
      });
    },
    async preflight(env,input){
      const estimate=estimateTask(modelProfile(env),input), budget=Number(env.MEETING_TASK_BUDGET_USD||0);
      requireThat(Number.isFinite(budget)&&budget>=0,'invalid_task_budget',400);
      if(budget>0){requireThat(estimate.pricingKnown,'agent_pricing_unavailable',409);requireThat(estimate.cost<=budget,'agent_budget_exceeded',409);}
      return estimate;
    },
    async adopt(kind,owner,externalId,sourceIds,requestId=externalId){
      const id=key(kind,owner,requestId),binding=digest([String(externalId),[...new Set(sourceIds)].sort()]);
      if(adopted.has(id)){requireThat(adopted.get(id)===binding,'agent_request_conflict',409);return id;}
      let row=await repo.get(id);
      if(!row){row={id,kind:'meeting-task',owner,taskKind:kind,externalId:String(externalId),sourceIds:[...new Set(sourceIds)].sort(),requestId,createdAt:new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString()};await repo.insert(row);}
      requireThat(row.externalId===String(externalId)&&digest([...row.sourceIds].sort())===digest([...new Set(sourceIds)].sort()),'agent_request_conflict',409);
      adopted.set(id,binding);if(adopted.size>2048)adopted.delete(adopted.keys().next().value);return id;
    },
    async submit(owner,{kind,requestId,sourceIds,payload},trustedContext){
      requireThat(typeof owner==='string'&&typeof requestId==='string'&&requestId.length>0&&requestId.length<=128&&Array.isArray(sourceIds)&&sourceIds.length>0&&sourceIds.length<=32&&sourceIds.every(id=>typeof id==='string')&&new Set(sourceIds).size===sourceIds.length,'invalid_agent_request',400);
      const adapter=adapters.get(kind);requireThat(adapter,'meeting_task_kind_unavailable',503);
      await adapter.validate?.(owner,payload,trustedContext);
      const selected=await adapter.sources?.(owner,payload,trustedContext);
      if(selected)requireThat(digest([...selected].sort())===digest([...sourceIds].sort()),'agent_request_conflict',409);
      const identity=key(kind,owner,requestId),requestHash=digest([payload,trustedContext||null]);
      const operation=(submissions.get(identity)||Promise.resolve()).catch(()=>{}).then(async()=>{
        const existing=await repo.get(identity);
        if(existing){
          requireThat(!existing.requestHash||existing.requestHash===requestHash,'agent_request_conflict',409);
          requireThat(digest([...existing.sourceIds].sort())===digest([...new Set(sourceIds)].sort()),'agent_request_conflict',409);
          if(existing.requestHash)return {...await adapter.inspect(owner,existing.externalId),kernelId:identity};
        }
        const value=await adapter.submit(owner,{...payload,requestId},trustedContext);
        const id=await kernel.adopt(kind,owner,value.id,sourceIds,requestId);
        await repo.change(id,row=>{row.requestHash=requestHash;});return {...value,kernelId:id};
      });
      submissions.set(identity,operation);
      try{return await operation;}finally{if(submissions.get(identity)===operation)submissions.delete(identity);}
    },
    async inspect(owner,id){
      const row=await repo.get(id);requireThat(row?.owner===owner,'meeting_task_not_found',404);await guard(row);
      const adapter=adapters.get(row.taskKind);requireThat(adapter,'meeting_task_kind_unavailable',503);
      return {...await adapter.inspect(owner,row.externalId),kernelId:id,taskKind:row.taskKind};
    },
    async cancel(owner,id){
      const row=await repo.get(id);requireThat(row?.owner===owner,'meeting_task_not_found',404);await guard(row);
      const adapter=adapters.get(row.taskKind);requireThat(adapter?.cancel,'meeting_task_not_cancellable',409);
      await adapter.cancel(owner,row.externalId);return kernel.inspect(owner,id);
    },
    async diagnostics(owner,id){
      const task=await kernel.inspect(owner,id);
      const activity=task.activity?Object.fromEntries(['state','reason','kind','startedAt'].filter(key=>task.activity[key]!==undefined).map(key=>[key,task.activity[key]])):undefined;
      // Allowlist only. Never export prompts, titles, questions, source text,
      // tool arguments/results, remote URLs or provider error bodies.
      return {schema:'lingji.task-diagnostic.v1',taskKind:task.taskKind,status:task.status,phase:task.phase,error:task.error,progress:task.progress,...(activity?{activity}:{}),ledger:task.ledger,timeline:(task.timeline||[]).map(({kind,startedAt,elapsedMs,usage,usageReported,pricingKnown,name})=>({kind,startedAt,elapsedMs,usage,usageReported,pricingKnown,name})),terminal:terminal.has(task.status),exportedAt:new Date(now()).toISOString()};
    },
    async close(){closing=true;clearInterval(timer);for(const item of queue.splice(0))item.reject(new DomainError('agent_runtime_closed',503));await Promise.allSettled([...handles].map(async([handle,context])=>handle.close(context)));handles.clear();kernels.delete(repo);}
  };
  kernels.set(repo,kernel);return kernel;
}

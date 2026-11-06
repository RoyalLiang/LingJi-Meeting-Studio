import { randomUUID,createHash } from 'node:crypto';
import { requireThat } from '../../../packages/records/src/record.mjs';
import { meetingTasks } from './meeting-tasks.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kinds=new Set(['meeting-completed','weekly-decisions','open-actions']);
// Producers only create read-only task requests. No notification or action item
// is sent outside the application, even when a rule says "reminder".
export function createMeetingTaskProducers(repo,{now=Date.now,pollMs=60000}={}){
 const kernel=meetingTasks(repo);let busy=false,closed=false;
 async function owned(owner,id){const rule=await repo.get(id);requireThat(rule?.kind==='meeting-task-rule'&&rule.owner===owner,'meeting_task_rule_not_found',404);return rule;}
 async function save(owner,input){
  requireThat(input&&typeof input.enabled==='boolean'&&kinds.has(input.trigger)&&Array.isArray(input.recordIds)&&input.recordIds.length>0&&input.recordIds.length<=32&&new Set(input.recordIds).size===input.recordIds.length&&input.recordIds.every(id=>typeof id==='string')&&typeof input.prompt==='string'&&input.prompt.trim().length>0&&input.prompt.length<=2000,'invalid_task_rule',400);
  requireThat(!input.enabled||input.confirmed===true,'agent_scope_required',400);
  const access=await repo.getRecordAccess(input.recordIds);requireThat(access.length===input.recordIds.length&&access.every(row=>row.owner===owner&&!row.deleted&&Date.parse(row.deleteAt)>now()),'agent_scope_denied',403);
  const current=input.id?await owned(owner,input.id):null,id=current?.id||`meeting-task-rule:${randomUUID()}`;
  const value={id,kind:'meeting-task-rule',owner,enabled:input.enabled,trigger:input.trigger,recordIds:[...input.recordIds].sort(),prompt:input.prompt.trim(),generation:randomUUID(),createdAt:current?.createdAt||now(),updatedAt:now(),nextAt:now()+(input.trigger==='weekly-decisions'?604800000:input.trigger==='open-actions'?86400000:0)};
  if(current)await repo.change(id,row=>Object.assign(row,value));else await repo.insert(value);return value;
 }
 async function process(rule,changed){
  if(!rule.enabled||changed&&!rule.recordIds.some(id=>changed.includes(id)))return;
  if(rule.trigger!=='meeting-completed'&&now()<rule.nextAt)return;
  const records=[];for(const id of rule.recordIds){const record=await repo.get(id);if(record?.kind==='record'&&record.owner===rule.owner&&!record.deleted&&Date.parse(record.deleteAt)>now()&&record.capture==='completed'&&record.transcription==='ready'&&record.segments.length&&!record.jobs.some(job=>['running','queued'].includes(job.status)))records.push(record);}
  if(!records.length)return;
  const window=rule.trigger==='meeting-completed'?records.map(record=>[record.id,record.transcriptRevision,record.minutesRevision]):rule.nextAt;
  const requestId=digest([rule.id,rule.generation,window]);if(rule.lastRequestId===requestId)return;
  const latest=await owned(rule.owner,rule.id);if(!latest.enabled||latest.generation!==rule.generation)return;
  const task=await kernel.submit(rule.owner,{kind:'assistant',requestId,sourceIds:records.map(record=>record.id),payload:{recordIds:records.map(record=>record.id),requestId,prompt:rule.prompt,scopeConfirmed:true,skillId:'meeting-review'}});
  await repo.change(rule.id,row=>{if(row.generation!==rule.generation)return;row.lastRequestId=requestId;row.lastTaskId=task.kernelId;row.lastRunAt=now();if(rule.trigger!=='meeting-completed')row.nextAt=rule.nextAt+(Math.floor((now()-rule.nextAt)/(rule.trigger==='weekly-decisions'?604800000:86400000))+1)*(rule.trigger==='weekly-decisions'?604800000:86400000);});
 }
 async function tick(changed){if(closed||busy)return;busy=true;try{for(const rule of await repo.list('meeting-task-rule'))try{await process(rule,changed);}catch(error){await repo.change(rule.id,row=>{row.error=/^(?:agent_[a-z_]+|minutes_not_configured|invalid_[a-z_]+)$/.test(error.code||'')?error.code:'agent_failed';});}}finally{busy=false;}}
 const timer=setInterval(()=>void tick().catch(()=>{}),Math.max(100,pollMs));timer.unref();
 return {save,list:owner=>repo.listMetadata('meeting-task-rule',owner,['enabled','trigger','recordIds','prompt','createdAt','updatedAt','nextAt','lastTaskId','lastRunAt','error']),tick,sourceChanged:ids=>tick(ids),close(){closed=true;clearInterval(timer);}};
}

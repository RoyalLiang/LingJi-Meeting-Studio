import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {tokenUsage} from '../../../packages/records/src/usage.mjs';

const context=new AsyncLocalStorage();
const dayOf=time=>new Date(new Date(time).getTime()+8*3600000).toISOString().slice(0,10);
const dayId=(owner,workspaceId,day)=>'usage-day-'+createHash('sha256').update(JSON.stringify([owner,workspaceId,day])).digest('hex');
export const withModelUsage=(scope,run)=>scope?context.run(scope,run):run();
export const enterModelUsage=scope=>context.enterWith(scope);

async function usageEpoch(repo,owner){
  const id='usage-epoch-'+createHash('sha256').update(owner).digest('hex');
  let value=await repo.get(id);
  if(!value){
    const legacy=await repo.listMetadata('record',owner,['createdAt'],{limit:1});
    try{await repo.insert({id,kind:'model-usage-epoch',owner,createdAt:new Date().toISOString(),historicalUnknown:legacy.length>0});}catch(error){if(error.code!=='already_exists')throw error;}
    value=await repo.get(id);
  }
  return value;
}

async function ensureDay(repo,owner,workspaceId,day){
  const id=dayId(owner,workspaceId,day);
  try{await repo.insert({id,kind:'model-usage-day',owner,workspaceId,day,createdAt:day,requests:0,incomplete:0,tokens:0});}
  catch(error){if(error.code!=='already_exists')throw error;}
  return id;
}
function total(usage){return usage.totalTokens??(Number.isSafeInteger(usage.inputTokens)&&Number.isSafeInteger(usage.outputTokens)?usage.inputTokens+usage.outputTokens:null);}
function account(day,request,sign){day.requests+=sign;day.incomplete+=sign*(total(request.usage)===null?1:0);day.tokens+=sign*(total(request.usage)??0);}

// Legacy jobs have receipts but no per-call timestamps. Preserve totals without inventing dates.
async function historicalUsage(repo,owner,epoch){
  if(epoch.historicalReceipts)return epoch.historicalReceipts;
  let receipts=[];
  for(let attempt=0;attempt<3;attempt++){
    const revision=await repo.accessRevision(),records=[];
    for(const input of await repo.listOverviewInputs(owner)){
      if(Date.parse(input.createdAt)>=Date.parse(epoch.createdAt))continue;
      const record=await repo.get(input.id);
      if(record?.owner===owner)records.push({id:record.id,workspaceId:record.workspaceId,createdAt:record.createdAt,usage:record.usage,jobs:record.jobs.map(({id,createdAt,usageCalls})=>({id,createdAt,usageCalls})),events:record.events.filter(event=>event.type==='minutes.usage')});
    }
    const current=new Map();let before,active=false;
    for(;;){
      const page=await repo.listMetadata('model-usage',owner,['recordId','requestKind','createdAt','usage','finishedAt'],{limit:1000,before});
      for(const row of page){
        if(row.requestKind!=='minutes'||!row.recordId)continue;
        current.set(row.recordId,(current.get(row.recordId)||0)+(total(tokenUsage(row.usage))??0));
        if(!row.finishedAt)active=true;
      }
      if(page.length<1000)break;
      const last=page.at(-1);before=[last.createdAt,last.id];
    }
    receipts=[];
    for(const record of records){
      const workspaceId=record.workspaceId||'inbox';let known=0,dated=0;
      for(const job of record.jobs||[]){
        const tokens=Object.values(job.usageCalls||{}).reduce((sum,call)=>sum+(call?.reported?total(tokenUsage(call))??0:0),0);
        if(!Number.isSafeInteger(tokens)||tokens<=0)continue;
        known+=tokens;
        const at=(record.events||[]).filter(event=>event.type==='minutes.usage'&&event.payload?.jobId===job.id).at(-1)?.at;
        if(!at||!Number.isFinite(Date.parse(at))||!Number.isFinite(Date.parse(job.createdAt))||Date.parse(at)>=Date.parse(epoch.createdAt))continue;
        receipts.push({workspaceId,from:dayOf(job.createdAt),to:dayOf(at),tokens});dated+=tokens;
      }
      const meter=record.usage?.minutesMeter;
      if(Number.isSafeInteger(meter?.totalTokens)&&meter.totalTokensRequests>0)known=Math.max(known,meter.totalTokens);
      // New physical calls can also be present in old job meters. Subtract their known receipts once.
      const remaining=Math.max(0,known-dated-(current.get(record.id)||0));
      if(remaining)receipts.push({workspaceId,from:dayOf(record.createdAt),to:dayOf(epoch.createdAt),tokens:remaining});
    }
    if(revision!==await repo.accessRevision())continue;
    if(active)return receipts;
    const saved=await repo.change(epoch.id,row=>{row.historicalReceipts||=receipts;});
    return saved.historicalReceipts;
  }
  return receipts;
}

// Persist at the transport boundary: retries are distinct, streamed cumulative reports are not.
export async function meterModelCall(config,options,call){
  const scope=options.usageContext||context.getStore();
  if(!scope?.repo||!scope.owner)return call(options);
  const {repo,owner,workspaceId='inbox',recordId,taskId,kind='model'}=scope;
  await usageEpoch(repo,owner);
  let id;
  const update=async(value,finished=false)=>{
    if(!id)return;
    const previous=await repo.get(id),day=finished?dayOf(Date.now()):previous.day;
    const nextDay=await ensureDay(repo,owner,workspaceId,day);
    await repo.changeMany([id,previous.dayId,nextDay],rows=>{
      const request=rows.find(row=>row.id===id),oldDay=rows.find(row=>row.id===request.dayId);
      account(oldDay,request,-1);
      for(const [key,count] of Object.entries(tokenUsage(value)))request.usage[key]=Math.max(request.usage[key]??0,count);
      request.day=day;request.dayId=nextDay;
      if(finished)request.finishedAt=new Date().toISOString();
      account(rows.find(row=>row.id===nextDay),request,1);
    });
  };
  try{
    const result=await call({...options,onRequest:async()=>{
      await options.onRequest?.();
      if(id)return;
      const startedAt=new Date().toISOString(),day=dayOf(startedAt),bucket=await ensureDay(repo,owner,workspaceId,day);
      id=randomUUID();
      await repo.insert({id,kind:'model-usage',owner,workspaceId,recordId,taskId,requestKind:kind,model:String(config.LLM_MODEL||config.DOUBAO_TRANSLATION_MODEL||'').slice(0,200),createdAt:startedAt,startedAt,day,dayId:bucket,usage:{}});
      await repo.change(bucket,row=>{row.requests++;row.incomplete++;});
    },onUsage:async value=>{await update(value);await options.onUsage?.(value);}});
    await update(result?.tokenUsage||result?.usage);
    return result;
  }finally{await update({},true);}
}

export async function modelUsageOverview(repo,owner,scope='all',now=Date.now()){
  const epoch=await usageEpoch(repo,owner),cutover=dayOf(epoch.createdAt);
  const historical=(await historicalUsage(repo,owner,epoch)).filter(row=>scope==='all'||row.workspaceId===scope);
  const buckets=historical.filter(row=>row.from===row.to).map(row=>({day:row.from,tokens:row.tokens,incomplete:0}));let before;
  for(;;){
    const page=await repo.listMetadata('model-usage-day',owner,['workspaceId','day','createdAt','tokens','requests','incomplete'],{limit:1000,before});
    buckets.push(...page.filter(row=>scope==='all'||row.workspaceId===scope));
    if(page.length<1000)break;
    const last=page.at(-1);before=[last.createdAt,last.id];
  }
  const today=dayOf(now),end=Date.parse(today),start=end-364*86400000;
  const days=new Map();
  for(const row of buckets){const value=days.get(row.day)||{tokens:0,incomplete:0};value.tokens+=row.tokens;value.incomplete+=row.incomplete;days.set(row.day,value);}
  const activity=Array.from({length:365},(_,i)=>{const day=new Date(start+i*86400000).toISOString().slice(0,10),value=days.get(day);return {day,minutesTokens:value?.tokens??0,usageIncomplete:Boolean(value?.incomplete||epoch.historicalUnknown&&day<=cutover)};});
  const weekday=(new Date(end).getUTCDay()+6)%7;
  const periods=Object.fromEntries([['day',today],['week',new Date(end-weekday*86400000).toISOString().slice(0,10)],['month',today.slice(0,7)+'-01'],['year',today.slice(0,4)+'-01-01']].map(([id,from])=>{
    const values=[...days].filter(([day])=>day<=today&&day>=from).map(([,value])=>value);
    return [id,{minutesTokens:values.reduce((sum,value)=>sum+value.tokens,0)+historical.filter(row=>row.from!==row.to&&row.from>=from&&row.to<=today).reduce((sum,row)=>sum+row.tokens,0),usageIncomplete:values.some(value=>value.incomplete>0)||epoch.historicalUnknown&&from<=cutover}];
  }));
  return {activity,periods};
}

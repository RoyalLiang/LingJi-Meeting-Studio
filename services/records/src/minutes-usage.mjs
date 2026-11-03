import { randomUUID } from 'node:crypto';
import { beginMinutesUsage, updateMinutesUsage, tokenUsage } from '../../../packages/records/src/usage.mjs';

export async function meteredMinutesCall(repo,recordId,claim,generate,input,config,options={}) {
 if(claim.mode==='extractive')return generate(input,config,options);
 const attempts=[];
 const createAttempt=()=>{
  const callId=randomUUID(),received={};let beginning;
  const onRequest=()=>beginning ||= (async()=>{await repo.change(recordId,record=>beginMinutesUsage(record,claim,callId));if(options.onRequest)await options.onRequest();})();
  const onUsage=async usage=>{
   let changed=false;
   for(const [field,value] of Object.entries(tokenUsage(usage)))if(received[field]===undefined || value>received[field]){received[field]=value;changed=true;}
   if(!changed)return;
   await onRequest();await repo.change(recordId,record=>updateMinutesUsage(record,claim,callId,received));
   if(options.onUsage)await options.onUsage(usage);
  };
  const attempt={onRequest,onUsage};attempts.push(attempt);return attempt;
 };
 const first=createAttempt();
 const result=await generate(input,config,{...options,...first,newAttempt:createAttempt});
 // Physical retries each report their own usage. Never mark an unknown retry as zero.
 if(attempts.length===1){
  await first.onRequest();
  const usage=tokenUsage(result.tokenUsage);
  if(Object.keys(usage).length)await first.onUsage(usage);
  else if(result.usageReported!==false && Number.isSafeInteger(result.usageTokens) && result.usageTokens>=0)await first.onUsage({totalTokens:result.usageTokens});
 }
 return result;
}

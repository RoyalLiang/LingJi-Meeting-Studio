import { randomUUID } from 'node:crypto';
import { beginMinutesUsage, updateMinutesUsage, tokenUsage } from '../../../packages/records/src/usage.mjs';

export async function meteredMinutesCall(repo,recordId,claim,generate,input,config,options={}) {
 if(claim.mode==='extractive')return generate(input,config,options);
 const callId=randomUUID();
 let beginning;
 const onRequest=()=>beginning ||= (async()=>{await repo.change(recordId,record=>beginMinutesUsage(record,claim,callId));if(options.onRequest)await options.onRequest();})();
 const received={};
 const onUsage=async usage=>{
  let changed=false;
  for(const [field,value] of Object.entries(tokenUsage(usage)))if(received[field]===undefined || value>received[field]){received[field]=value;changed=true;}
  if(!changed)return;
  await onRequest();
  await repo.change(recordId,record=>updateMinutesUsage(record,claim,callId,received));
  if(options.onUsage)await options.onUsage(usage);
 };
 const result=await generate(input,config,{...options,onRequest,onUsage});
 await onRequest();
 // Legacy injected providers may return an explicit total, whereas adapters
 // mark missing provider usage as unknown instead of manufacturing a zero.
 const usage=tokenUsage(result.tokenUsage);
 if(Object.keys(usage).length)await onUsage(usage);
 else if(result.usageReported!==false && Number.isSafeInteger(result.usageTokens) && result.usageTokens>=0)await onUsage({totalTokens:result.usageTokens});
 return result;
}

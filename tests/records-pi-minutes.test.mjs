import test from 'node:test';
import assert from 'node:assert/strict';
import { completeMinutesWithPi } from '../services/records/src/pi-minutes.mjs';
import { DomainError } from '../packages/records/src/record.mjs';

test('real Pi runs fixed minutes through the existing provider contract and retains usage/deltas',async()=>{
  let calls=0,deltas='';const messages=[{role:'system',content:'Cite only supplied revisions.'},{role:'user',content:'Fixed transcript revision 2.'}];
  const output=await completeMinutesWithPi(messages,{LLM_MODEL:'fixture'},{onDelta:value=>{deltas+=value;}},async(received,env,options)=>{
    calls++;assert.equal(received,messages);assert.equal(env.LLM_MODEL,'fixture');await options.onDelta('draft');
    return {title:'会议纪要',sections:[],actions:[],usageTokens:11,tokenUsage:{inputTokens:7,outputTokens:4,totalTokens:11},runtime:{durationMs:1}};
  });
  assert.equal(calls,1);assert.equal(deltas,'draft');assert.equal(output.runtime.engine,'pi');assert.equal(output.usageTokens,11);
});
test('Pi preserves provider errors and cancellation rather than manufacturing minutes',async()=>{
  await assert.rejects(completeMinutesWithPi([{role:'user',content:'fixture'}],{LLM_MODEL:'fixture'},{},async()=>{throw new DomainError('provider_unauthorized',502);}),{code:'provider_unauthorized'});
  const controller=new AbortController();controller.abort();await assert.rejects(completeMinutesWithPi([],{LLM_MODEL:'fixture'},{signal:controller.signal},async()=>{throw new Error('must not call');}),{name:'AbortError'});
});

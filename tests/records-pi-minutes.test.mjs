import test from 'node:test';
import assert from 'node:assert/strict';
import { completeMinutesWithPi } from '../services/records/src/pi-minutes.mjs';
import { DomainError } from '../packages/records/src/record.mjs';
import {minutesReasoningEffort} from '../services/records/src/minutes-reasoning.mjs';
import {modelResponseError} from '../services/records/src/model-errors.mjs';
import {MEETING_COMPACTION} from '../services/records/src/meeting-agent-context.mjs';

test('real Pi runs fixed minutes through the existing provider contract and retains usage/deltas',async()=>{
  let calls=0,deltas='';const messages=[{role:'system',content:'Cite only supplied revisions.'},{role:'user',content:'Fixed transcript revision 2.'}];
  const output=await completeMinutesWithPi(messages,{LLM_MODEL:'fixture'},{onDelta:value=>{deltas+=value;}},async(received,env,options)=>{
    calls++;assert.ok(JSON.stringify(received).includes('Fixed transcript revision 2.'));assert.equal(env.LLM_MODEL,'fixture');await options.onDelta('{"title":"draft"}');await options.onUsage({inputTokens:7,outputTokens:4,totalTokens:11});
    return {title:'会议纪要',sections:[],actions:[],usageTokens:11,tokenUsage:{inputTokens:7,outputTokens:4,totalTokens:11},runtime:{durationMs:1}};
  });
  assert.equal(calls,1);assert.equal(deltas,'{"title":"draft"}');assert.equal(output.runtime.engine,'pi');assert.equal(output.usageTokens,11);
});
test('real Pi minutes calls bounded source and Skill tools and meters each model request',async()=>{
  let calls=0,requests=0;
  const output=await completeMinutesWithPi([{role:'system',content:'Cite only the frozen transcript.'},{role:'user',content:JSON.stringify({transcript:[{id:0,text:'frozen source'}]})}],{LLM_MODEL:'fixture'},{onRequest:()=>{requests++;},reasoningEffort:'low'},async(messages,_env,options)=>{
    calls++;await options.onRequest?.();await options.onUsage({inputTokens:7,outputTokens:4,totalTokens:11});
    if(calls===1)return {toolCalls:[{name:'read_selected_skill',arguments:{key:'citation-check'}},{name:'read_selected_meeting',arguments:{part:'transcript',page:0}}]};
    const transcript=JSON.parse(messages[1].content);
    assert.equal(transcript.messages.filter(item=>item.role==='toolResult').length,2);
    assert.ok(JSON.stringify(transcript.messages).includes('frozen source'));
    return {title:'合成纪要',sections:[],actions:[]};
  });
  assert.equal(requests,2);assert.equal(calls,2);assert.equal(output.usageTokens,22);
  assert.deepEqual(output.runtime.tools.sort(),['read_selected_meeting','read_selected_skill']);
});
test('Pi preserves provider errors and cancellation rather than manufacturing minutes',async()=>{
  await assert.rejects(completeMinutesWithPi([{role:'user',content:'fixture'}],{LLM_MODEL:'fixture'},{},async()=>{throw new DomainError('provider_unauthorized',502);}),{code:'provider_unauthorized'});
  const controller=new AbortController();controller.abort();await assert.rejects(completeMinutesWithPi([],{LLM_MODEL:'fixture'},{signal:controller.signal},async()=>{throw new Error('must not call');}),{name:'AbortError'});
});
test('reasoning follows work stage and exact model capability ceiling',()=>{
  const env={LLM_MODEL:'fixture'};
  assert.equal(minutesReasoningEffort({stage:'window',scope:'final'},env),'low');
  assert.equal(minutesReasoningEffort({scope:'live'},env),'medium');
  assert.equal(minutesReasoningEffort({stage:'synthesis'},env),'high');
  assert.equal(minutesReasoningEffort({scope:'final'},env,{repair:true}),'high');
  const large={...env,LLM_MODEL_PROFILES:JSON.stringify({fixture:{reasoningEfforts:['low','medium','high','xhigh']}})};
  assert.equal(minutesReasoningEffort({stage:'synthesis'},large),'xhigh');
  assert.equal(minutesReasoningEffort({stage:'compression'},large),'low');
  assert.equal(minutesReasoningEffort({scope:'live'},{...env,LLM_MODEL_FACTS:{reasoningUnsupported:true}}),'auto');
  assert.equal(minutesReasoningEffort({stage:'synthesis'},{...large,LLM_MODEL_FACTS:{reasoningUnsupported:true}}),'auto','observed refusal constrains a declared capability');
});
test('unsupported reasoning is classified safely and retries once with provider default',async()=>{
  const failure=modelResponseError(400,{error:{code:'unsupported_parameter',param:'reasoning_effort',message:'private source: reasoning_effort is not supported'}});
  assert.equal(failure.code,'provider_reasoning_unsupported');assert.ok(!failure.message.includes('private source'));
  const efforts=[];
  const output=await completeMinutesWithPi([{role:'user',content:'frozen text'}],{LLM_MODEL:'fixture'},{reasoningEffort:'medium'},async(_messages,env,options)=>{
    efforts.push(env.LLM_REASONING_EFFORT);if(efforts.length===1)throw failure;
    await options.onUsage({inputTokens:2,outputTokens:1,totalTokens:3});return {title:'合成纪要',sections:[],actions:[]};
  });
  assert.deepEqual(efforts,['medium','auto']);assert.equal(output.runtime.reasoningFallback,true);assert.equal(output.runtime.reasoningEffort,'auto');
  assert.equal(modelResponseError(400,{error:{message:'maximum context length is 8192 tokens; reasoning_effort unsupported'}}).code,'context_length_exceeded');
  assert.equal(modelResponseError(400,{error:{message:'invalid request'}}).code,'provider_http_400');
});
test('provider continuation and unknown metadata never enter saved minutes content',async()=>{
  const result=await completeMinutesWithPi([{role:'user',content:'fixed'}],{LLM_MODEL:'fixture'},{},async()=>({title:'合成纪要',sections:[],actions:[],continuation:[{type:'thinking',thinkingSignature:'private-provider-marker'}],privateMetadata:'not-domain-content'}));
  assert.equal(result.continuation,undefined);assert.equal(result.privateMetadata,undefined);assert.ok(!JSON.stringify(result).includes('private-provider-marker'));
});
test('compaction uses actual Pi tool history rather than replaying the initial source',async()=>{
  const source=JSON.stringify({transcript:[{id:0,text:'fixed synthetic source '.repeat(350)}]}),compressed=[];let normal=0;
  const result=await completeMinutesWithPi([{role:'system',content:'Frozen minutes contract.'},{role:'user',content:source}],{LLM_MODEL:'fixture',LLM_MODEL_PROFILES:JSON.stringify({fixture:{contextWindow:4096,maxOutputTokens:1024}})},{timeoutMs:3000},async(messages,_env,options)=>{
    const compacting=messages[0].content.startsWith(MEETING_COMPACTION);
    await options.onRequest?.();await options.onUsage({inputTokens:compacting?100:normal===0?3500:100,outputTokens:10,totalTokens:compacting?110:normal===0?3510:110});
    if(compacting){compressed.push(messages[1].content);return {summary:'Checkpoint: first frozen pages read; continue final minutes.'};}
    if(++normal===2)throw new DomainError('context_length_exceeded',502);
    if(normal===1)return {toolCalls:[{name:'read_selected_meeting',arguments:{part:'transcript',page:0}},{name:'read_selected_meeting',arguments:{part:'transcript',page:1}}]};
    return {title:'Synthetic minutes',sections:[],actions:[]};
  });
  assert.equal(result.title,'Synthetic minutes');assert.ok(compressed.length>0);assert.ok(compressed.every(text=>text!==source));assert.ok(compressed.some(text=>text.includes('toolResult')||text.includes('[Tool result]')));
});
test('only reported total tokens remain total-only and global timeouts have a domain code',async()=>{
  let reported;
  const result=await completeMinutesWithPi([{role:'user',content:'fixed'}],{LLM_MODEL:'fixture'},{onUsage:value=>{reported=value;}},async(_messages,_env,options)=>{await options.onUsage({totalTokens:11});return {title:'Known total',sections:[],actions:[]};});
  assert.deepEqual(result.tokenUsage,{totalTokens:11});assert.deepEqual(reported,{totalTokens:11});
  await assert.rejects(completeMinutesWithPi([{role:'user',content:'fixed'}],{LLM_MODEL:'fixture'},{timeoutMs:40},async(_messages,_env,options)=>{await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}),{code:'llm_timeout'});
});

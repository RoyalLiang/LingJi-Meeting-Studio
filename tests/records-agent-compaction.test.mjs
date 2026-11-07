import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredModels,meetingFailureCode} from '../services/records/src/meeting-agent.mjs';
import {MEETING_COMPACTION} from '../services/records/src/meeting-agent-context.mjs';

async function compact(t,fail=false){
  const original=globalThis.fetch,metrics=[],requests=[];
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    if(fail||!body.stream)return Response.json({error:{code:'gateway_timeout'}},{status:504});
    return Response.json({output_text:JSON.stringify({summary:'已读分页和引用保留在合成检查点中。'}),usage:{input_tokens:50,output_tokens:10,total_tokens:60}});
  };
  const env={LLM_MODEL:'synthetic',LLM_API_KEY:'synthetic',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'responses',LLM_MODEL_PROFILES:JSON.stringify({synthetic:{nativeTools:true}})};
  const bridge=configuredModels('/synthetic',env,1000,undefined,undefined,metric=>{metrics.push(metric);});
  const model=bridge.models.getModel(bridge.model.provider,bridge.model.modelId);
  const result=await bridge.models.completeSimple(model,{messages:[{role:'system',content:MEETING_COMPACTION+' Preserve read pages and citations.',timestamp:Date.now()},{role:'user',content:[{type:'text',text:'Synthetic checkpoint fragment.'}],timestamp:Date.now()}]});
  return {result,metrics,requests};
}

test('Responses compaction streams without inheriting archive tools or exposing checkpoint deltas',async t=>{
  const {result,metrics,requests}=await compact(t);
  assert.equal(result.stopReason,'stop');assert.equal(requests.length,1);
  assert.equal(requests[0].stream,true);assert.equal(requests[0].tools,undefined);
  assert.equal(metrics[0].kind,'compaction');assert.equal(metrics[0].usage.totalTokens,60);
});

test('wrapped compaction errors retain the latest safe model failure instead of a generic failure',async t=>{
  const {result,metrics}=await compact(t,true);
  assert.equal(result.stopReason,'error');assert.equal(metrics.at(-1).error,'provider_http_504');
  assert.equal(meetingFailureCode('agent_failed',metrics),'provider_http_504');
  assert.equal(meetingFailureCode('agent_scope_denied',metrics),'agent_scope_denied');
  assert.equal(meetingFailureCode('agent_failed',null),'agent_failed');
  assert.equal(meetingFailureCode('agent_failed',[...metrics,{kind:'tool'}]),'agent_failed');
  assert.equal(meetingFailureCode('agent_failed',[{kind:'compaction',error:'private upstream response'}]),'agent_failed');
});

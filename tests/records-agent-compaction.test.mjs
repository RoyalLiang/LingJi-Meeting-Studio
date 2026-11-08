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

async function overflowRecovery(t,again=false){
 const {Harness,createRegistry,defineExtension,defineTool,hook,CompactionTask}=await import('@earendil-works/pi-durable');
 const {MemoryStorage}=await import('@earendil-works/pi-durable/storage/memory');
 const {obj,str}=await import('@earendil-works/pi-schema');
 const {BACKGROUND_CONTEXT:context}=await import('@earendil-works/chord/context');
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'pi-overflow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let requests=0,compactions=0;const bodies=[];
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);bodies.push(body);requests++;
   if(requests===1)return Response.json({choices:[{message:{tool_calls:[{id:'read-one',function:{name:'read_selected_meeting',arguments:'{"recordId":"synthetic"}'}}]},finish_reason:'tool_calls'}]});
   if(requests===2||again&&requests>2)return Response.json({error:{code:'context_length_exceeded',message:'maximum context length is 32000 tokens private-synthetic-fragment'}},{status:400});
   return Response.json({choices:[{message:{content:'{"summary":"done","decisions":[],"actions":[]}'},finish_reason:'stop'}]});
 };
 const bridge=configuredModels(root,{LLM_MODEL:'synthetic',LLM_API_KEY:'synthetic',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'chat-completions',LLM_MODEL_PROFILES:JSON.stringify({synthetic:{nativeTools:true,contextWindow:64000}})});
 const registry=createRegistry();registry.install(defineExtension({name:'overflow-test@1',tools:[defineTool({name:'read_selected_meeting',description:'Synthetic source',parameters:obj({recordId:str()}),execute:async()=>({output:[{type:'text',text:'synthetic evidence '.repeat(500)}]})})],hooks:[hook(CompactionTask,{beforeCompact:async()=>{compactions++;return {summary:'Synthetic source has been read.'};}})]}));
 const harness=await Harness.open(new MemoryStorage(),{models:bridge.models,registry,settings:{compaction:{enabled:true,reserveTokens:1000,keepRecentTokens:0,backgroundTokens:0}}},context);t.after(()=>harness.close(context));
 const conversation=await harness.root(context,{agent:{model:bridge.model}}),submission=await conversation.submit({type:'input',content:'Read synthetic source then return JSON.'},context),done=await submission.wait(context);
 assert.equal(done.status,again?'unanswered':'done',JSON.stringify(done));assert.equal(compactions,1);assert.equal(requests,3);assert.ok(bodies.every(body=>body.tools?.length));
}
test('real Pi generation compacts and retries overflow once without dropping native tools',async t=>overflowRecovery(t));
test('repeated overflow terminates after one Pi compaction instead of a retry loop',async t=>overflowRecovery(t,true));

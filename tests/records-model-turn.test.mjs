import test from 'node:test';
import assert from 'node:assert/strict';
import {isContextOverflow} from '@earendil-works/pi-ai/utils/overflow';
import {completeModelJson} from '../services/records/src/llm.mjs';
import { completeModelTurn } from '../services/records/src/model-turn.mjs';
import { modelProfile, piUsage, estimateTask,contextPolicy,estimateTextTokens } from '../services/records/src/model-profile.mjs';
import {configuredModels} from '../services/records/src/meeting-agent.mjs';
import {taskLedger} from '../services/records/src/meeting-tasks.mjs';

const env = { LLM_MODEL:'fixture', LLM_API_KEY:'synthetic', LLM_PROTOCOL:'chat-completions', LLM_API_URL:'https://fixture.invalid/v1', LLM_MODEL_PROFILES:JSON.stringify({fixture:{nativeTools:true,strictOutput:true,parallelTools:true,contextWindow:64000,prices:{input:1,output:2,cacheRead:0.1,cacheWrite:1}}}) };
test('native tools preserve call IDs, multiple calls, strict final schema and actual usage', async t => {
  const original = globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  let request;
  globalThis.fetch=async (_url, options)=>{request=JSON.parse(options.body);return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call-a',function:{name:'read',arguments:'{"page":0}'}},{id:'call-b',function:{name:'read',arguments:'{"page":1}'}}]}}],usage:{prompt_tokens:120,completion_tokens:20,total_tokens:140,prompt_tokens_details:{cached_tokens:40}}});};
  const result=await completeModelTurn({messages:[{role:'user',content:[{type:'text',text:'read'}]}],tools:[{name:'read',description:'read',parameters:{type:'object',properties:{page:{type:'integer'}},required:['page']}}]},env,{jsonSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false}});
  assert.equal(request.tools[0].type,'function'); assert.equal(request.parallel_tool_calls,true);assert.equal(request.response_format.json_schema.strict,true);
  assert.deepEqual(result.toolCalls.map(c=>c.id),['call-a','call-b']);assert.equal(result.tokenUsage.totalTokens,140);
  const usage=piUsage(result.tokenUsage,modelProfile(env));assert.equal(usage.input,80);assert.equal(usage.cacheRead,40);assert.ok(usage.cost.total>0);
});
test('Responses uses native function result items and text.format strict',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let body;
  globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"summary":"done"}'}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}});};
  const result=await completeModelTurn({messages:[{role:'assistant',content:[{type:'toolCall',id:'abc',name:'read',arguments:{page:0}}]},{role:'toolResult',toolCallId:'abc',toolName:'read',content:[{type:'text',text:'page'}]}]}, {...env,LLM_PROTOCOL:'responses'}, {jsonSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false}});
  assert.equal(body.input[0].type,'function_call');assert.equal(body.input[1].call_id,'abc');assert.equal(body.text.format.strict,true);assert.equal(result.result.summary,'done');
});
test('unrecognized models stay on JSON compatibility and unknown prices remain unknown',()=>{
  const profile=modelProfile({LLM_MODEL:'unknown',LLM_PROTOCOL:'responses'});assert.equal(profile.nativeTools,false);assert.equal(estimateTask(profile,{characters:1000,pages:2}).cost,null);
});
test('missing or partial usage cannot become a zero-cost receipt; partial price catalogs stay unknown',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let reports=0;
 globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"summary":"ok"}'}}]});
 const value=await completeModelTurn({messages:[]},env,{onUsage:()=>reports++});assert.equal(reports,0);assert.equal(Object.keys(value.tokenUsage).length,0);
 const ledger=taskLedger([{kind:'model',usage:piUsage({totalTokens:100},modelProfile(env)),usageReported:true,usageComplete:false,pricingKnown:true}]);assert.equal(ledger.cost,null);
 const partial=modelProfile({...env,LLM_MODEL_PROFILES:JSON.stringify({fixture:{prices:{input:1}}})});assert.equal(partial.prices,null);assert.equal(estimateTask(partial,{characters:100,pages:1}).cost,null);
});
test('Pi normalized tools and patched prompt sections become native declarations',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let body;
 globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'{"summary":"ok"}'}}]});};
 await completeModelTurn({messages:[{role:'system',content:'base',sections:{scope:'old'},toolsAdded:[{name:'old',parameters:{type:'object'}}]},{role:'system',content:'',sections:{scope:'frozen-scope'},toolsRemoved:[{name:'old'}],toolsAdded:[{name:'read',parameters:{type:'object'}}]}]},env);
 assert.equal(body.tools.length,1);assert.equal(body.tools[0].function.name,'read');assert.match(body.messages[0].content,/frozen-scope/);assert.doesNotMatch(body.messages[0].content,/old/);
});
test('Responses encrypted reasoning survives the next tool turn',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let request,round=0;
 globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return Response.json(++round===1?{output:[{type:'reasoning',id:'rs_fixture',summary:[],encrypted_content:'opaque-fixture'},{type:'function_call',call_id:'call-one',name:'read',arguments:'{}'}]}:{output:[{type:'message',content:[{type:'output_text',text:'{"summary":"done"}'}]}]});};
 const config={...env,LLM_PROTOCOL:'responses'},first=await completeModelTurn({messages:[]},config);
 await completeModelTurn({messages:[{role:'assistant',content:[...first.continuation,{type:'toolCall',id:'call-one',name:'read',arguments:{}}]},{role:'toolResult',toolCallId:'call-one',content:[{type:'text',text:'synthetic'}]}]},config);
 assert.equal(request.input[0].encrypted_content,'opaque-fixture');assert.equal(request.input[1].type,'function_call');assert.equal(request.input[2].type,'function_call_output');
});
test('JSON compatibility and compaction enforce the output cap admitted by the budget',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const bodies=[];
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);bodies.push(body);return Response.json({choices:[{message:{content:JSON.stringify(body.messages[0].content.startsWith('MEETING_SOURCE_CONTEXT_CHECKPOINT')?{summary:'checkpoint'}:{result:{summary:'done',decisions:[],actions:[]}})}}]});};
 const config={...env,LLM_MODEL_PROFILES:JSON.stringify({fixture:{nativeTools:false,contextWindow:24000,maxOutputTokens:1024}})},selected=configuredModels('/unused',config);
 await selected.models.completeSimple(selected.model,{messages:[{role:'user',content:[{type:'text',text:'synthetic'}]}]});
 await selected.models.completeSimple(selected.model,{messages:[{role:'system',content:'MEETING_SOURCE_CONTEXT_CHECKPOINT_V1 synthetic'},{role:'user',content:[{type:'text',text:'synthetic'}]}]});
 assert.equal(bodies.length,2);assert.ok(bodies.every(body=>body.max_completion_tokens===1024));
});
test('unsupported native parameters fall back to JSON but provider quota errors do not',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let count=0;
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);count++;return body.tools?Response.json({error:{type:'invalid_request_error',message:'tools is not supported'}},{status:400}):Response.json({choices:[{message:{content:'{"result":{"summary":"done","decisions":[],"actions":[]}}'}}]});};
 const selected=configuredModels('/unused',env);await selected.models.completeSimple(selected.model,{messages:[{role:'user',content:'synthetic'}],tools:[{name:'read',parameters:{type:'object'}}]});assert.equal(count,2);
 count=0;globalThis.fetch=async()=>{count++;return Response.json({error:{type:'budget_exceeded'}},{status:422});};const quota=configuredModels('/unused',env),answer=await quota.models.completeSimple(quota.model,{messages:[{role:'user',content:'synthetic'}]});assert.equal(answer.errorMessage,'provider_budget_exceeded');assert.equal(count,1);
});

// Same source and round limit must not be billed as a full model window each turn.
test('large model windows do not inflate admission for unchanged meeting material',()=>{
 const base={LLM_MODEL:'fixture',LLM_PROTOCOL:'chat-completions'};
 const profile=size=>modelProfile({...base,LLM_MODEL_PROFILES:JSON.stringify({fixture:{contextWindow:size,prices:{input:1,output:2,cacheRead:0.1,cacheWrite:1}}})});
 const small=estimateTask(profile(16384),{characters:360000,pages:30,maxRounds:128});
 const large=estimateTask(profile(1000000),{characters:360000,pages:30,maxRounds:128});
 assert.ok(large.inputTokens<small.inputTokens*4,JSON.stringify({small,large}));
});

test('context overflow stays recognizable to Pi in native and compatibility transports without tool fallback',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let count=0;
 globalThis.fetch=async()=>{count++;return Response.json({error:{code:'context_length_exceeded',message:'maximum context length is 32000 tokens; private-synthetic-text'}},{status:400});};
 for(const complete of [completeModelTurn,completeModelJson]){
   await assert.rejects(complete===completeModelTurn?complete({messages:[]},env):complete([],env),error=>error.code==='context_length_exceeded'&&!error.message.includes('private-synthetic-text'));
 }
 count=0;const bridge=configuredModels('/unused',env);
 const answer=await bridge.models.completeSimple(bridge.model,{messages:[{role:'user',content:[{type:'text',text:'synthetic'}]}]});
 assert.equal(count,1);assert.equal(isContextOverflow(answer),true);
});

test('effective window is capped, explicit large context opts in, overflow can only lower it',()=>{
 const configured={...env,LLM_MODEL_PROFILES:JSON.stringify({fixture:{contextWindow:1000000}})};
 assert.equal(modelProfile(configured).contextWindow,262144);
 const large=modelProfile({...configured,LLM_MODEL_PROFILES:JSON.stringify({fixture:{contextWindow:1000000,effectiveContextWindow:1000000}})});
 assert.equal(large.contextWindow,1000000);assert.ok(contextPolicy(large).pageChars>contextPolicy(modelProfile({})).pageChars);
 const limited=modelProfile({...configured,LLM_MODEL_FACTS:{contextLimit:32000}});assert.equal(limited.contextWindow,32000);
 assert.ok(estimateTextTokens('中文原文')>estimateTextTokens('text'));
 assert.throws(()=>modelProfile({...env,LLM_MODEL_PROFILES:JSON.stringify({fixture:[]})}),/invalid_model_profile/);
});

test('gateway facts have provenance, exact-model precedence and durable downward-only observations',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {readModelFacts,discoverModelFacts,observeModelFacts}=await import('../services/records/src/model-facts.mjs');
 const root=await mkdtemp(join(tmpdir(),'lingji-model-facts-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const config={...env,LLM_API_URL:'https://gateway.example/v1',LLM_MODEL_PROFILES:''};
 globalThis.fetch=async()=>Response.json({data:[{id:'other',context_length:1000000},{id:'fixture',context_length:131072,supported_parameters:['tools'],top_provider:{max_completion_tokens:8192}}]});
 await discoverModelFacts(root,config);let facts=await readModelFacts(root,config);
 assert.equal(facts.catalog.contextWindow,131072);assert.ok(facts.evidence.every(item=>item.at&&item.confirmed===false));
 assert.equal(modelProfile({...config,LLM_MODEL_FACTS:facts}).source,'gateway-unconfirmed');
 assert.equal(modelProfile({...env,LLM_MODEL_FACTS:facts}).contextWindow,64000);
 await observeModelFacts(root,config,{contextLimit:32000,inputTokens:1500,counts:{cjk:1000,json:0,latin:0}});
 await observeModelFacts(root,config,{contextLimit:64000,inputTokens:3000,counts:{cjk:1000,json:1000,latin:1000}});
 facts=await readModelFacts(root,config);assert.equal(facts.contextLimit,32000);assert.ok(facts.tokenRatios.cjk>1.5);assert.equal(facts.tokenRatios.json,undefined);
 assert.equal((await readModelFacts(root,{...config,LLM_API_URL:'https://other.example/v1'})).catalog,undefined);
});

test('queued compatibility tools retain authorization but are marked as replay instead of provider work',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let requests=0;const admissions=[];
 globalThis.fetch=async()=>{requests++;return Response.json({choices:[{message:{content:JSON.stringify({toolCalls:[0,1].map(page=>({name:'read_selected_meeting',arguments:{recordId:'synthetic',page}}))})}}]});};
 const bridge=configuredModels('/unused',{...env,LLM_MODEL_PROFILES:'{}'},undefined,undefined,(_signal,meta)=>{admissions.push(meta);});
 const first=await bridge.models.completeSimple(bridge.model,{messages:[]});await bridge.models.completeSimple(bridge.model,{messages:[first]});
 assert.equal(requests,1);assert.deepEqual(admissions.map(item=>item.replay),[false,true]);
});

test('a lower observed context limit immediately clamps the current model output cap',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>Response.json({error:{code:'context_length_exceeded',message:'maximum context length is 8192 tokens'}},{status:400});
 const bridge=configuredModels('/unused',{...env,LLM_MODEL_PROFILES:JSON.stringify({fixture:{contextWindow:64000,maxOutputTokens:32768}})});
 const answer=await bridge.models.completeSimple(bridge.model,{messages:[]});assert.equal(isContextOverflow(answer),true);
 const model=bridge.models.getModel(bridge.model.provider,bridge.model.modelId);assert.equal(model.contextWindow,8192);assert.equal(model.maxTokens,4096);assert.equal(bridge.profile.maxOutputTokens,4096);
});

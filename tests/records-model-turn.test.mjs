import test from 'node:test';
import assert from 'node:assert/strict';
import { completeModelTurn } from '../services/records/src/model-turn.mjs';
import { modelProfile, piUsage, estimateTask } from '../services/records/src/model-profile.mjs';
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
 globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);count++;return body.tools?Response.json({error:{type:'invalid_request_error'}},{status:400}):Response.json({choices:[{message:{content:'{"result":{"summary":"done","decisions":[],"actions":[]}}'}}]});};
 const selected=configuredModels('/unused',env);await selected.models.completeSimple(selected.model,{messages:[{role:'user',content:'synthetic'}],tools:[{name:'read',parameters:{type:'object'}}]});assert.equal(count,2);
 count=0;globalThis.fetch=async()=>{count++;return Response.json({error:{type:'budget_exceeded'}},{status:422});};const quota=configuredModels('/unused',env),answer=await quota.models.completeSimple(quota.model,{messages:[{role:'user',content:'synthetic'}]});assert.equal(answer.errorMessage,'provider_budget_exceeded');assert.equal(count,1);
});

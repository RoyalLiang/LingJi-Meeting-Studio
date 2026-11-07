import test from 'node:test';
import assert from 'node:assert/strict';
import {readModelTurnResponse} from '../services/records/src/model-turn-stream.mjs';
import {completeModelTurn} from '../services/records/src/model-turn.mjs';

const env={LLM_MODEL:'synthetic',LLM_API_KEY:'synthetic-key',LLM_API_URL:'https://fixture.invalid/v1',LLM_PROTOCOL:'chat-completions'};
const frame=(value,newline='\n')=>`data: ${JSON.stringify(value)}${newline}${newline}`;
function stream(source,{newline='\n',step=7}={}){
 const text=Array.isArray(source)?source.map(value=>frame(value,newline)).join(''):source;
 const bytes=new TextEncoder().encode(text);let offset=0;
 return new Response(new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,offset+step));offset=Math.min(bytes.length,offset+step);}}),{headers:{'Content-Type':'text/event-stream'}});
}
async function withResponse(response,protocol=env.LLM_PROTOCOL){
 const original=globalThis.fetch;
 let request;globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return response;};
 try{const result=await completeModelTurn({messages:[{role:'user',content:'Synthetic evidence only.'}]},{...env,LLM_PROTOCOL:protocol});
 assert.equal(request.stream,true);if(protocol==='chat-completions')assert.equal(request.stream_options.include_usage,true);return result;
 }finally{globalThis.fetch=original;}
}

test('native Chat SSE joins fragmented arguments, preserves Unicode and reports final usage',async()=>{
 const chunks=[
  {choices:[{delta:{tool_calls:[{index:1,id:'second',function:{name:'read_file',arguments:'{"path":"'}}]}}]},
  {choices:[{delta:{tool_calls:[{index:0,id:'first',function:{name:'read_selected_',arguments:'{"recordId":"s",'}}]}}]},
  {choices:[{delta:{tool_calls:[{index:1,function:{arguments:'巴塔哥尼亚.md"}'}},{index:0,function:{name:'meeting',arguments:'"page":1}'}}]},finish_reason:null}]},
  {choices:[{delta:{reasoning_content:'retained opaque continuation'},finish_reason:'tool_calls'}]},
  {choices:[],usage:{prompt_tokens:120,completion_tokens:20,total_tokens:140,prompt_tokens_details:{cached_tokens:40}}},
 ];
 const result=await withResponse(stream(chunks,{step:1}));
 assert.deepEqual(result.toolCalls.map(({id,name,arguments:args})=>({id,name,args})),[{id:'first',name:'read_selected_meeting',args:{recordId:'s',page:1}},{id:'second',name:'read_file',args:{path:'巴塔哥尼亚.md'}}]);
 assert.equal(result.tokenUsage.totalTokens,140);assert.equal(result.tokenUsage.cachedInputTokens,40);
 assert.equal(JSON.parse(result.continuation[0].thinkingSignature).reasoning_content,'retained opaque continuation');
});

test('native Responses SSE uses the completed response and retains reasoning, tools and usage',async()=>{
 const response={status:'completed',output:[{type:'reasoning',id:'reasoning-one',encrypted_content:'opaque',summary:[]},{type:'function_call',call_id:'call-one',name:'read_selected_meeting',arguments:'{"recordId":"source","page":2}'}],usage:{input_tokens:11,output_tokens:7,total_tokens:18}};
 const result=await withResponse(stream([{type:'response.created',response:{status:'in_progress'}},{type:'response.function_call_arguments.delta',delta:'{"recordId"'},{type:'response.completed',response}]),'responses');
 assert.equal(result.toolCalls[0].arguments.page,2);assert.equal(result.tokenUsage.totalTokens,18);
 assert.equal(JSON.parse(result.continuation[0].thinkingSignature).item.encrypted_content,'opaque');
});

test('CRLF split across byte chunks and an EOF tail frame produce one complete result',async()=>{
 const source=frame({choices:[{delta:{content:'{"summary":"原始引用不变"}'},finish_reason:null}]},'\r\n')+`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}`;
 const result=await withResponse(stream(source,{step:1}));assert.deepEqual(result.result,{summary:'原始引用不变'});
});

test('native SSE accepts comments, multiline data and terminal DONE after a valid finish',async()=>{
 const source=': keepalive\n\n'+ 'data: {"choices":\n'+'data: [{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\n'+'data: [DONE]\n\n';
 const result=await readModelTurnResponse(stream(source),false);assert.equal(result.choices[0].message.content,'{}');
});

for(const [name,source,responses,code] of [
 ['Chat without finish',frame({choices:[{delta:{content:'{}'}}]})+'data: [DONE]\n\n',false,'llm_stream_incomplete'],
 ['Responses without completion',frame({type:'response.output_text.delta',delta:'{}'}),true,'llm_stream_incomplete'],
 ['truncated Chat finish',frame({choices:[{delta:{content:'{}'},finish_reason:'length'}]}),false,'llm_stream_incomplete'],
 ['content-filter Chat finish',frame({choices:[{delta:{content:'{}'},finish_reason:'content_filter'}]}),false,'llm_stream_incomplete'],
 ['failed Responses event',frame({type:'response.failed',response:{status:'failed'}}),true,'llm_stream_failed'],
 ['incomplete Responses event',frame({type:'response.incomplete',response:{status:'incomplete'}}),true,'llm_stream_failed'],
 ['error event',frame({error:{message:'synthetic'}}),false,'llm_stream_failed'],
 ['malformed event','data: {not-json}\n\n',false,'invalid_llm_response'],
 ['oversized SSE',':'+ 'x'.repeat(2000001),false,'llm_response_too_large'],
 ])test(`native stream rejects ${name}`,async()=>{await assert.rejects(readModelTurnResponse(stream(source,{step:65536}),responses),{code});});

test('completed native tools still reject truncated arguments before tools are returned',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>stream([{choices:[{delta:{tool_calls:[{index:0,id:'call',function:{name:'read_selected_meeting',arguments:'{"recordId":'}}]},finish_reason:'tool_calls'}]}]);
 await assert.rejects(completeModelTurn({messages:[]},env),{code:'invalid_agent_output'});
});

test('buffered JSON compatibility keeps Chat results, Responses tools and HTTP error classification',async t=>{
 let result=await withResponse(Response.json({choices:[{message:{content:'{"summary":"buffered"}'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}));
 assert.equal(result.result.summary,'buffered');assert.equal(result.tokenUsage.totalTokens,4);
 result=await withResponse(Response.json({status:'completed',output:[{type:'function_call',call_id:'buffered-call',name:'read_selected_meeting',arguments:'{"recordId":"s"}'}]}),'responses');
 assert.equal(result.toolCalls[0].id,'buffered-call');
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>Response.json({error:{message:'synthetic'}},{status:401});
 await assert.rejects(completeModelTurn({messages:[]},env),{code:'provider_unauthorized'});
});

for(const responses of [true,false])test(`native ${responses?'Responses':'Chat'} terminal frame cancels a provider that keeps SSE open`,async()=>{
 let cancelled=false;const frames=responses?[{type:'response.completed',response:{status:'completed',output_text:'{"summary":"done"}',usage:{input_tokens:1,output_tokens:2}}}]:[{choices:[{delta:{content:'{"summary":"done"}'},finish_reason:'stop'}]},{usage:{prompt_tokens:1,completion_tokens:2},choices:[]}];
 const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(frames.map(value=>frame(value)).join('')));},cancel(){cancelled=true;}});
 let timer;try{await Promise.race([readModelTurnResponse(new Response(body,{headers:{'Content-Type':'text/event-stream'}}),responses),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('waited for EOF after terminal frame')),500);})]);assert.equal(cancelled,true);}finally{clearTimeout(timer);}
});

for(const responses of [true,false])test(`native ${responses?'Responses':'Chat'} incomplete stream preserves provider-reported usage`,async()=>{
 const usage=responses?{input_tokens:10,output_tokens:2,total_tokens:12}:{prompt_tokens:10,completion_tokens:2,total_tokens:12},seen=[];
 const events=responses?[{type:'response.incomplete',response:{status:'incomplete',usage}}]:[{usage,choices:[]}];
 await assert.rejects(readModelTurnResponse(stream(events),responses,{onUsage:async value=>{seen.push(value);}}));assert.deepEqual(seen,[usage]);
});

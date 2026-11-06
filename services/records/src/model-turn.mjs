import { normalizeConfig, configured } from './config.mjs';
import { modelEndpoint } from './llm.mjs';
import { modelProfile } from './model-profile.mjs';
import { tokenUsage } from '../../../packages/records/src/usage.mjs';
import {getCurrentTools,getCurrentSystemMessage,getSystemMessageText} from '@earendil-works/pi-ai';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

const text = content => typeof content === 'string' ? content : (content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
function messagesFor(transcript, responses) {
  const messages = transcript.systemPrompt ? [{role:'system',content:transcript.systemPrompt}] : [];
  const system=getCurrentSystemMessage(transcript.messages||[]);
  if(system)messages.push({role:'system',content:getSystemMessageText(system)});
  for (const message of transcript.messages || []) {
    if(message.role==='system')continue;
    if (message.role === 'toolResult') {
      messages.push(responses ? {type:'function_call_output',call_id:message.toolCallId,output:text(message.content)} : {role:'tool',tool_call_id:message.toolCallId,content:text(message.content)});
    } else if (message.role === 'assistant') {
      const calls = (message.content || []).filter(item => item.type === 'toolCall'), content = text(message.content);
      let reasoning;
      for(const part of message.content||[])if(part.type==='thinking'&&part.thinkingSignature){
        try{const state=JSON.parse(part.thinkingSignature);if(responses&&state.protocol==='responses'&&state.item?.type==='reasoning')messages.push(state.item);else if(!responses&&state.protocol==='chat-completions')reasoning=state.reasoning_content;}catch{/* A foreign provider signature is not transferable. */}
      }
      if (responses) {
        if (content) messages.push({role:'assistant',content});
        for (const call of calls) messages.push({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments)});
      } else messages.push({role:'assistant',content:content || null,...(typeof reasoning==='string'?{reasoning_content:reasoning}:{}),...(calls.length ? {tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))} : {})});
    } else messages.push({role:message.role,content:text(message.content)});
  }
  return messages;
}

// Native protocol at the provider seam. Domain tools and final citations still
// pass the same host authorization and validation as the compatibility path.
export async function completeModelTurn(transcript, input, {jsonSchema, signal, timeoutMs=120000, onUsage, onRequest} = {}) {
  const env=normalizeConfig(input), profile=modelProfile(env), responses=env.LLM_PROTOCOL==='responses';
  requireThat(configured(env.LLM_API_KEY)&&env.LLM_MODEL,'minutes_not_configured',503);
  const tools=(transcript.tools || getCurrentTools(transcript.messages||[])).map(tool=>responses ? {type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:false} : {type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters,strict:false}});
  const format=jsonSchema&&profile.strictOutput ? {type:'json_schema',name:'meeting_result',schema:jsonSchema,strict:true} : {type:'json_object'};
  const messages=messagesFor(transcript,responses), body=responses ? {model:env.LLM_MODEL,input:messages,store:false,text:{format},max_output_tokens:profile.maxOutputTokens} : {model:env.LLM_MODEL,messages,response_format:format.type==='json_schema'?{type:'json_schema',json_schema:{name:format.name,schema:format.schema,strict:true}}:format,max_completion_tokens:profile.maxOutputTokens};
  if (tools.length) Object.assign(body,{tools,parallel_tool_calls:profile.parallelTools});
  if (!['auto','default',undefined].includes(env.LLM_REASONING_EFFORT)) Object.assign(body,responses?{reasoning:{effort:env.LLM_REASONING_EFFORT}}:{reasoning_effort:env.LLM_REASONING_EFFORT});
  const deadline=AbortSignal.timeout(timeoutMs), requestSignal=signal?AbortSignal.any([signal,deadline]):deadline;
  const started=Date.now(); await onRequest?.();
  try {
    const response=await fetch(modelEndpoint(env.LLM_API_URL,env.LLM_PROTOCOL),{method:'POST',headers:{Authorization:`Bearer ${env.LLM_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:requestSignal});
    // Bounded reads also protect the buffered native-tool path.
    const reader=response.body?.getReader(), decoder=new TextDecoder();let source='',bytes=0;
    if(reader) try { while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;requireThat(bytes<=2000000,'llm_response_too_large',502);source+=decoder.decode(next.value,{stream:true});}source+=decoder.decode(); } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    let result;try{result=JSON.parse(source);}catch{throw new DomainError('invalid_llm_response',502);}
    if(!response.ok) throw new DomainError(result?.error?.type==='budget_exceeded'||result?.error?.code==='budget_exceeded'?'provider_budget_exceeded':response.status===401?'provider_unauthorized':response.status===429?'provider_rate_limited':`provider_http_${response.status}`,502);
    const usage=tokenUsage(result.usage);if(Object.keys(usage).length)await onUsage?.({...usage,model:env.LLM_MODEL,protocol:env.LLM_PROTOCOL});
    const continuation=responses?(result.output||[]).filter(item=>item.type==='reasoning').map(item=>({type:'thinking',thinking:'',thinkingSignature:JSON.stringify({protocol:'responses',item})})):typeof result.choices?.[0]?.message?.reasoning_content==='string'?[{type:'thinking',thinking:'',thinkingSignature:JSON.stringify({protocol:'chat-completions',reasoning_content:result.choices[0].message.reasoning_content})}]:[];
    requireThat(!responses||!result.status||result.status==='completed','llm_stream_incomplete',502);
    requireThat(responses||!['length','content_filter'].includes(result.choices?.[0]?.finish_reason),'llm_stream_incomplete',502);
    const calls=responses?(result.output||[]).filter(item=>item.type==='function_call').map(item=>({id:item.call_id,name:item.name,arguments:item.arguments})): (result.choices?.[0]?.message?.tool_calls||[]).map(item=>({id:item.id,name:item.function?.name,arguments:item.function?.arguments}));
    if(calls.length){requireThat(calls.length<=8,'invalid_agent_output',502);return {continuation,toolCalls:calls.map(call=>{const args=JSON.parse(call.arguments);requireThat(call.id&&call.name&&args&&typeof args==='object'&&!Array.isArray(args),'invalid_agent_output',502);return {...call,arguments:args};}),tokenUsage:usage,elapsedMs:Date.now()-started};}
    const content=responses?(result.output_text||(result.output||[]).flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join('')):result.choices?.[0]?.message?.content;
    const value=JSON.parse(content);requireThat(value&&typeof value==='object'&&!Array.isArray(value),'invalid_agent_output',502);
    return {result:value,continuation,tokenUsage:usage,elapsedMs:Date.now()-started};
  } catch(error) {
    if(error instanceof DomainError)throw error;
    if(requestSignal.aborted)throw new DomainError(deadline.aborted?'llm_timeout':'llm_cancelled',502);
    throw new DomainError(error instanceof SyntaxError?'invalid_agent_output':'llm_connection_failed',502);
  }
}

const evidence={type:'array',items:{type:'object',properties:{recordId:{type:'string'},segmentId:{type:'string'},revision:{type:'integer'}},required:['recordId','segmentId','revision'],additionalProperties:false}};
const statement={type:'object',properties:{text:{type:'string'},evidence},required:['text','evidence'],additionalProperties:false};
export const meetingResultSchema={type:'object',properties:{summary:{type:'string'},decisions:{type:'array',items:statement},actions:{type:'array',items:{...statement,properties:{...statement.properties,owner:{type:['string','null']}},required:['text','evidence','owner']}}},required:['summary','decisions','actions'],additionalProperties:false};

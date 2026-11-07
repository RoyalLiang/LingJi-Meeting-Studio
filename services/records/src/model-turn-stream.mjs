import {DomainError,requireThat} from '../../../packages/records/src/record.mjs';

// Native tool arguments must be complete before a tool may execute.
export async function readModelTurnResponse(response,responses,{onUsage}={}){
 const streamed=response.ok&&(response.headers.get('content-type')||'').includes('text/event-stream');
 const reader=response.body?.getReader(),decoder=new TextDecoder(),calls=new Map();
 let buffer='',bytes=0,source='',content='',reasoning='',usage,finish,completed=false,done=false,result,usageKey='';
 async function reportUsage(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const key=JSON.stringify(value);if(key===usageKey)return;usageKey=key;await onUsage?.(value);
 }
 async function event(frame){
  const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data)return;
  if(data==='[DONE]'){done=true;return;}
  let value;try{value=JSON.parse(data);}catch{throw new DomainError('invalid_llm_response',502);}
  await reportUsage(value.usage||value.response?.usage);
  if(value.error||['error','response.failed','response.incomplete'].includes(value.type))throw new DomainError('llm_stream_failed',502);
  if(responses){
   if(value.type==='response.completed'){requireThat(value.response?.status==='completed','llm_stream_incomplete',502);result=value.response;completed=true;}
   return;
  }
  if(value.usage)usage=value.usage;
  const choice=value.choices?.[0];if(!choice)return;
  const delta=choice.delta||{};content+=delta.content||'';reasoning+=delta.reasoning_content||'';
  for(const part of delta.tool_calls||[]){
   requireThat(Number.isInteger(part.index)&&part.index>=0&&part.index<8,'invalid_agent_output',502);
   const call=calls.get(part.index)||{id:'',type:'function',function:{name:'',arguments:''}};
   if(part.id)call.id=part.id;
   call.function.name+=part.function?.name||'';call.function.arguments+=part.function?.arguments||'';calls.set(part.index,call);
  }
  if(choice.finish_reason){finish=choice.finish_reason;completed=true;}
 }
 try{
  read: if(reader)while(true){
   const next=await reader.read();if(next.done)break;bytes+=next.value.length;requireThat(bytes<=2000000,'llm_response_too_large',502);
   const chunk=decoder.decode(next.value,{stream:true});
   if(!streamed){source+=chunk;continue;}
   buffer=(buffer+chunk).replace(/\r\n/g,'\n');let at;
   while((at=buffer.indexOf('\n\n'))>=0){await event(buffer.slice(0,at));buffer=buffer.slice(at+2);if(done||responses&&completed||!responses&&completed&&usage){buffer='';break read;}}
  }
  if(!streamed){source+=decoder.decode();let value;try{value=JSON.parse(source);}catch{throw new DomainError('invalid_llm_response',502);}await reportUsage(value.usage);return value;}
  buffer+=decoder.decode();if(buffer.trim())await event(buffer);
  requireThat(completed&&!['length','content_filter'].includes(finish),'llm_stream_incomplete',502);
  if(responses)return result;
  return {choices:[{message:{content,reasoning_content:reasoning,tool_calls:[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,call])=>call)},finish_reason:finish}],usage};
 }finally{if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
}

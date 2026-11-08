import {readModelTurnResponse} from './model-turn-stream.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const cache=new Map(),writes=new Map();
const identity=env=>createHash('sha256').update(JSON.stringify([env.LLM_API_URL,env.LLM_PROTOCOL,env.LLM_MODEL,env.LLM_API_KEY])).digest('hex');
const file=root=>join(root,'model-facts.json');
async function load(root){
  if(!cache.has(root))cache.set(root,readFile(file(root),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT'||error instanceof SyntaxError)return {};throw error;}));
  return cache.get(root);
}
export async function readModelFacts(root,env){return (await load(root))[identity(env)]||{};}
async function save(root,env,change){
  const next=(writes.get(root)||Promise.resolve()).catch(()=>{}).then(async()=>{
    const all=await load(root),key=identity(env),facts=all[key]||{};change(facts);all[key]=facts;
    const entries=Object.entries(all);while(entries.length>64){const [old]=entries.shift();delete all[old];}
    const temp=file(root)+'.'+randomUUID();await writeFile(temp,JSON.stringify(all),{mode:0o600});await rename(temp,file(root));
  });writes.set(root,next);try{await next;}finally{if(writes.get(root)===next)writes.delete(root);}
}

export async function observeModelFacts(root,env,{contextLimit,inputTokens,counts,reasoningUnsupported}={}){
  if(!root)return;
  await save(root,env,facts=>{
    const at=new Date().toISOString();
    if(reasoningUnsupported===true){facts.reasoningUnsupported=true;facts.evidence=[...(facts.evidence||[]).filter(item=>item.field!=='reasoningUnsupported'),{field:'reasoningUnsupported',value:true,source:'provider-error',at,confirmed:true}];}
    if(Number.isSafeInteger(contextLimit)&&contextLimit>=1024&&contextLimit<=2000000){facts.contextLimit=Math.min(facts.contextLimit||2000000,contextLimit);facts.evidence=[...(facts.evidence||[]).filter(item=>item.field!=='contextLimit'),{field:'contextLimit',value:facts.contextLimit,source:'provider-overflow',at,confirmed:true}];}
    if(Number.isSafeInteger(inputTokens)&&inputTokens>0&&counts){
      facts.largestSuccessfulInput=Math.max(facts.largestSuccessfulInput||0,inputTokens);
      const total=Object.values(counts).reduce((sum,n)=>sum+n,0),kind=Object.keys(counts).find(key=>counts[key]/total>=.8);
      // Mixed prompts cannot identify three independent ratios from one usage number.
      if(kind&&total>=256){facts.tokenRatios||={};facts.tokenRatios[kind]=Math.max(.1,Math.min(4,inputTokens/total*1.15));facts.evidence=[...(facts.evidence||[]).filter(item=>item.field!==`tokenRatios.${kind}`),{field:`tokenRatios.${kind}`,value:facts.tokenRatios[kind],source:'reported-usage',at,confirmed:true}];}
    }
  });
}

export async function discoverModelFacts(root,env){
  if(!env.LLM_API_KEY||!env.LLM_MODEL||!env.LLM_API_URL)return;
  const previous=await readModelFacts(root,env);if(Date.now()-Date.parse(previous.checkedAt||'')<86400000)return;
  let base;try{base=new URL(env.LLM_API_URL);if(base.search||base.hash||base.hostname.endsWith('.invalid'))return;base.pathname=base.pathname.replace(/\/(?:responses|chat\/completions)\/?$/,'').replace(/\/$/,'');}catch{return;}
  const urls=[new URL(base.href),new URL(base.href)];urls[0].pathname+='/models';urls[1].pathname=base.pathname.replace(/\/v\d+$/,'')+'/model/info';
  let catalog,evidence=[];
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{Authorization:`Bearer ${env.LLM_API_KEY}`},signal:AbortSignal.timeout(2000),redirect:'error'});
      if(!response.ok){await response.body?.cancel();continue;}
      const result=await readModelTurnResponse(response,false),entry=result.data?.find(item=>(item.id||item.model_name)===env.LLM_MODEL);if(!entry)continue;
      const info=entry.model_info||entry,context=info.max_input_tokens||entry.context_length,output=info.max_output_tokens||entry.top_provider?.max_completion_tokens;
      if(!Number.isSafeInteger(context)||context<1024||context>2000000)continue;
      catalog={contextWindow:context,...(Number.isSafeInteger(output)&&output>=1024&&output<=Math.min(context,131072)?{maxOutputTokens:output}:{}),...(typeof info.supports_function_calling==='boolean'?{nativeTools:info.supports_function_calling}:{}),...(typeof info.supports_prompt_caching==='boolean'?{promptCache:info.supports_prompt_caching}:{})};
      if(Array.isArray(entry.supported_parameters))catalog.nativeTools=entry.supported_parameters.includes('tools');
      const input=info.input_cost_per_token??Number(entry.pricing?.prompt),out=info.output_cost_per_token??Number(entry.pricing?.completion);
      // Cache prices must be explicit; no metadata price is treated as a signed invoice.
      const read=info.cache_read_input_token_cost,write=info.cache_creation_input_token_cost;
      if([input,out,read,write].every(value=>Number.isFinite(value)&&value>=0))catalog.prices={input:input*1e6,output:out*1e6,cacheRead:read*1e6,cacheWrite:write*1e6};
      evidence=Object.entries(catalog).map(([field,value])=>({field,value,source:url.pathname.endsWith('/models')?'gateway-models':'gateway-model-info',at:new Date().toISOString(),confirmed:false}));break;
    }catch{/* Optional metadata failure preserves manual settings and conservative fallback. */}
  }
  await save(root,env,facts=>{facts.checkedAt=new Date().toISOString();if(catalog){facts.catalog=catalog;facts.evidence=[...(facts.evidence||[]).filter(item=>!item.source.startsWith('gateway-')),...evidence];}});
}

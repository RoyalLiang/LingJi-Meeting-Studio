import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { Harness, AssistantEntry, createRegistry } from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { completeModelJson } from './llm.mjs';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

// The existing worker owns durable windows/retries; Pi runs each fixed text window without duplicating disk histories.
export async function completeMinutesWithPi(messages, env, options = {}, complete = completeModelJson) {
  options.signal?.throwIfAborted();
  const model={id:env.LLM_MODEL,name:'Meeting minutes',provider:'lingji-minutes',api:'minutes-json',baseUrl:'',reasoning:false,input:['text'],contextWindow:128000,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let result,failure;
  const stream=(_model,_transcript,runOptions)=>{
    const events=createAssistantMessageEventStream();
    queueMicrotask(async()=>{
      let reason='stop';
      try{result=await complete(messages,env,{...options,signal:AbortSignal.any([...(options.signal?[options.signal]:[]),...(runOptions?.signal?[runOptions.signal]:[])])});}
      catch(error){failure=error;reason=options.signal?.aborted?'aborted':'error';}
      const usage=result?.tokenUsage||{};
      const answer={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:result?[{type:'text',text:JSON.stringify(result)}]:[],stopReason:reason,timestamp:Date.now(),
        usage:{input:usage.inputTokens||0,output:usage.outputTokens||0,cacheRead:usage.cachedInputTokens||0,cacheWrite:0,totalTokens:result?.usageTokens||0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},...(failure?{errorMessage:'minutes_generation_failed'}:{})};
      if(failure)events.push({type:'error',reason,error:answer});else events.push({type:'done',reason,message:answer});events.end(answer);
    });
    return events;
  };
  const models=createModels();models.setProvider(createProvider({id:model.provider,models:[model],auth:{apiKey:{name:'Server configuration',resolve:async()=>({auth:{}})}},api:{stream,streamSimple:stream}}));
  const harness=await Harness.open(new MemoryStorage(),{models,registry:createRegistry(),settings:{compaction:{enabled:false}}},context);
  let root;
  const abort=()=>{queueMicrotask(()=>{void root?.abort(context).catch(()=>{});});};
  try{
    root=await harness.root(context,{agent:{model:{provider:model.provider,modelId:model.id}}});
    options.signal?.addEventListener('abort',abort,{once:true});options.signal?.throwIfAborted();
    const submission=await root.submit({type:'input',content:messages.filter(item=>item.role==='user').map(item=>item.content).join('\n')},context);
    const settled=await submission.wait(context);options.signal?.throwIfAborted();
    if(failure)throw failure;
    requireThat(settled.status==='done'&&result,'pi_minutes_failed',502);
    const entry=await root.commit(tx=>tx.entry(AssistantEntry,settled.answer),context);
    requireThat(entry?.model?.[0]?.stopReason==='stop','pi_minutes_failed',502);
    return {...result,runtime:{...result.runtime,engine:'pi'}};
  }catch(error){if(error instanceof DomainError||options.signal?.aborted)throw error;throw new DomainError('pi_minutes_failed',502);}
  finally{options.signal?.removeEventListener('abort',abort);await harness.close(context);}
}

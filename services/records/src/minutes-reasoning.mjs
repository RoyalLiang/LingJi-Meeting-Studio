import {modelProfile} from './model-profile.mjs';
const levels=['low','medium','high','xhigh','max'];
export function minutesReasoningEffort(job,env,{repair=false}={}){
  const supported=modelProfile(env).reasoningEfforts;
  if(!supported.length||env.LLM_REASONING_EFFORT==='default')return 'auto';
  if(env.LLM_REASONING_EFFORT&&env.LLM_REASONING_EFFORT!=='auto')return env.LLM_REASONING_EFFORT;
  const desired=['window','compression'].includes(job.stage)?'low':repair||job.stage==='synthesis'?'xhigh':job.scope==='live'?'medium':'high';
  return levels.slice(0,levels.indexOf(desired)+1).reverse().find(level=>supported.includes(level))||'auto';
}

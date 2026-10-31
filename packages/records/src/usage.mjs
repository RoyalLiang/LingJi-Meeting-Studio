import { emit, requireThat } from './record.mjs';

const fields=['inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens'];
export function tokenUsage(input) {
 const source=input && typeof input==='object' ? input : {};
 const values={cachedInputTokens:source.cachedInputTokens ?? source.prompt_cache_hit_tokens ?? source.prompt_tokens_details?.cached_tokens ?? source.input_tokens_details?.cached_tokens,reasoningTokens:source.reasoningTokens ?? source.completion_tokens_details?.reasoning_tokens ?? source.output_tokens_details?.reasoning_tokens,inputTokens:source.input_tokens ?? source.prompt_tokens ?? source.inputTokens,outputTokens:source.output_tokens ?? source.completion_tokens ?? source.outputTokens,totalTokens:source.total_tokens ?? source.totalTokens};
 if(values.cachedInputTokens>values.inputTokens)delete values.cachedInputTokens;
 if(values.reasoningTokens>values.outputTokens)delete values.reasoningTokens;
 return Object.fromEntries(Object.entries(values).filter(([,value])=>Number.isSafeInteger(value) && value>=0));
}

export function beginMinutesUsage(record,claim,callId) {
 const job=record.jobs.find(job=>job.id===claim.id);
 requireThat(job && !record.deleted && record.generation===claim.generation && job.fence===claim.fence && job.status==='running','stale_job',410);
 job.usageCalls ||= {};
 if(job.usageCalls[callId])return false;
 job.usageCalls[callId]={fence:claim.fence,reported:false};
 record.usage.minutesMeter ||= {requests:0,reportedRequests:0};
 record.usage.minutesMeter.requests++;
 emit(record,'minutes.usage',{jobId:job.id});return true;
}

// A late response still consumed tokens. The original call binding, rather than
// the current content fence, allows its meter update without publishing content.
export function updateMinutesUsage(record,claim,callId,input) {
 const job=record.jobs.find(job=>job.id===claim.id),call=job?.usageCalls?.[callId];
 if(record.deleted || record.generation!==claim.generation || !call || call.fence!==claim.fence)return false;
 const usage=tokenUsage(input);if(!Object.keys(usage).length)return false;
 const meter=record.usage.minutesMeter;let changed=false;
 if(!call.reported){call.reported=true;meter.reportedRequests++;changed=true;}
 for(const field of fields) {
  if(usage[field]===undefined)continue;
  const previous=call[field],value=Math.max(previous ?? 0,usage[field]);
  if(previous===value)continue;
  const delta=value-(previous ?? 0),sum=(meter[field] || 0)+delta;
  if(!Number.isSafeInteger(sum))continue;
  if(previous===undefined)meter[`${field}Requests`]=(meter[`${field}Requests`] || 0)+1;
  call[field]=value;meter[field]=sum;changed=true;
  if(field==='totalTokens') {
   record.usage.llmTokens+=delta;job.pipelineUsageTokens=(job.pipelineUsageTokens || 0)+delta;
  }
 }
 if(changed)emit(record,'minutes.usage',{jobId:job.id});return changed;
}

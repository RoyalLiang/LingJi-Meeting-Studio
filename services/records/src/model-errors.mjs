import {isContextOverflow} from '@earendil-works/pi-ai/utils/overflow';
import {DomainError} from '../../../packages/records/src/record.mjs';

// Keep only a classified code and bounded numbers; upstream text may contain source data.
export function modelResponseError(status, result, fallback) {
  const error=result?.error||{}, text=[error.code,error.type,error.message].filter(value=>typeof value==='string').join(' ').slice(0,16000);
  const overflow=[400,413,422].includes(status)&&isContextOverflow({stopReason:'error',errorMessage:status===413?'413':text});
  const unsupported=[400,422].includes(status)&&/\b(?:tools|tool_choice|function.calling|parallel_tool_calls|response_format)\b/i.test(text)&&/unsupported|not supported|unknown parameter|unrecognized/i.test(text);
  const code=overflow?'context_length_exceeded':error.type==='budget_exceeded'||error.code==='budget_exceeded'?'provider_budget_exceeded':error.code==='InvalidEndpointOrModel.NotFound'?'llm_model_unavailable':status===401?'provider_unauthorized':status===429?'provider_rate_limited':unsupported?'provider_tools_unsupported':fallback||`provider_http_${status}`;
  const failure=new DomainError(code,502);
  if(overflow){
    const match=text.match(/(?:maximum context length(?:\s+(?:is|of))?|context (?:length|size)(?:\s+(?:is|of))?|limit of)\s*[:(]?\s*([\d,]+)\s*tokens?/i);
    const limit=Number(match?.[1]?.replaceAll(',',''));
    if(Number.isSafeInteger(limit)&&limit>=1024&&limit<=2000000)failure.contextLimit=limit;
  }
  return failure;
}

import type { Job, RecordDetail } from './model';

export function minutesUsageView(record: Pick<RecordDetail,'usage'> & Partial<Pick<RecordDetail,'durationMs'>>,job?: Pick<Job,'status'>) {
 const count=(value:unknown):value is number=>Number.isSafeInteger(value) && typeof value==='number' && value>=0;
 const usage=record.usage && typeof record.usage==='object' && !Array.isArray(record.usage) ? record.usage : undefined;
 const raw=usage?.minutesMeter;
 const meter=raw && typeof raw==='object' && !Array.isArray(raw) && count(raw.requests) && count(raw.reportedRequests) && raw.reportedRequests<=raw.requests ? raw : undefined;
 const running=['queued','running'].includes(job?.status || '');
 const seconds=typeof record.durationMs==='number' && Number.isFinite(record.durationMs) && record.durationMs>=0 ? Math.floor(record.durationMs/1000) : null;
 const audio=seconds===null ? '—' : `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
 const supplied=(value:unknown,reports:unknown)=>Boolean(meter && count(value) && count(reports) && reports>0 && reports<=meter.reportedRequests);
 const knownTotal=supplied(meter?.totalTokens,meter?.totalTokensRequests),knownInput=supplied(meter?.inputTokens,meter?.inputTokensRequests),knownOutput=supplied(meter?.outputTokens,meter?.outputTokensRequests);
 const number=(value:number)=>value.toLocaleString('zh-CN');
 const tokens=knownTotal ? `${number(meter?.totalTokens || 0)} token` : running ? '待回传' : '未提供';
 const input=knownInput ? number(meter?.inputTokens || 0) : '未提供';
 const output=knownOutput ? number(meter?.outputTokens || 0) : '未提供';
 const missing=Boolean(meter?.requests && (!knownTotal || meter.requests>(meter.totalTokensRequests || 0) || Boolean(knownInput && meter.requests>(meter.inputTokensRequests || 0)) || Boolean(knownOutput && meter.requests>(meter.outputTokensRequests || 0))));
 const status=running ? meter?.requests && !missing ? '用量持续更新' : '本轮用量待供应商回传' : missing ? '部分请求未提供完整用量' : knownTotal ? '供应商已回传' : '供应商未提供 token';
 const details=[supplied(meter?.cachedInputTokens,meter?.cachedInputTokensRequests)?`缓存输入 ${number(meter?.cachedInputTokens || 0)}`:'',supplied(meter?.reasoningTokens,meter?.reasoningTokensRequests)?`推理输出 ${number(meter?.reasoningTokens || 0)}`:''].filter(Boolean).join(' · ');
 return {audio,tokens,input,output,showBreakdown:knownInput || knownOutput,status,...(details?{details}:{})};
}

import type { RecordDetail } from '../model';
import { timecode } from '../model';
export function ProcessingProgress({record,localDurationMs,pending}:{record:RecordDetail;localDurationMs:number;pending:number}) {
  const transcript=record.segments.reduce((end,segment)=>Math.max(end,segment.endMs),0);
  const latest=record.capture==='completed' ? record.minutes || record.liveMinutes : record.liveMinutes || record.minutes;
  const minutes=latest?.evidenceSnapshot?.reduce((end,segment)=>Math.max(end,segment.endMs),0) || 0;
  return <div className="record-processing-progress" aria-label="原音与处理进度">
    <span title="包含已保存到本机队列和记录服务的实际音频时长">原音 <time>{timecode(localDurationMs)}</time></span>
    <span title="记录服务已持久化确认的音频">已保存 <time>{timecode(record.durationMs)}</time>{pending>0&&<small> · {pending} 段待保存</small>}</span>
    <span title="最近已确认转录片段的结束位置，不表示中间所有音频都已转录">最新转录 <time>{timecode(transcript)}</time></span>
    <span title="当前纪要引用快照的最新位置，不表示完整事实召回">纪要依据 <time>{timecode(minutes)}</time></span>
  </div>;
}

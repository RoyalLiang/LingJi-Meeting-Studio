import type { Job, RecordDetail } from '../model';
import { minutesUsageView } from '../minutes-usage';

export function MinutesUsage({record,job}:{record:RecordDetail;job?:Job}) {
 const usage=minutesUsageView(record,job);
 return <footer className="minutes-usage" aria-label="本场用量">
  <div className="minutes-usage-item"><span>已接收音频</span><strong>{usage.audio}</strong><small>音轨累计</small></div>
  <div className="minutes-usage-item"><span>模型用量</span><strong>{usage.tokens}</strong></div>
  {usage.showBreakdown && <div className="minutes-usage-item"><span>纪要输入 / 输出</span><strong>{usage.input} / {usage.output}</strong></div>}
  <span className="minutes-usage-status" role="status" aria-live="polite">{usage.status}</span>
 </footer>;
}

import type { Job, RecordDetail } from '../model';
import { minutesUsageView } from '../minutes-usage';

export function MinutesUsage({record,job}:{record:RecordDetail;job?:Job}) {
 const usage=minutesUsageView(record,job);
 return <footer className="minutes-usage" aria-label="本场用量">
  <div className="minutes-usage-item"><span>录音时长</span><strong>{usage.audio}</strong></div>
  <div className="minutes-usage-item"><span>模型用量</span><strong>{usage.tokens}</strong></div>
  {usage.showBreakdown && <div className="minutes-usage-item"><span>纪要输入 / 输出</span><strong>{usage.input} / {usage.output}</strong></div>}
  {usage.details && <div className="minutes-usage-item" title="缓存是输入的子集，推理是输出的子集，均已计入总量。"><span>用量明细</span><strong>{usage.details}</strong></div>}
  <span className="minutes-usage-status" role="status" aria-live="polite">{usage.status}</span>
 </footer>;
}

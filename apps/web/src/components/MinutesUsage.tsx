import type { Job, RecordDetail } from '../model';
import { minutesUsageView } from '../minutes-usage';

export function MinutesUsage({record,job}:{record:RecordDetail;job?:Job}) {
 const usage=minutesUsageView(record,job);
 return <footer className="minutes-usage" aria-label="本场用量">
  <div className="minutes-usage-item"><span>已保存录音</span><strong>{usage.audio}</strong></div>
  <div className="minutes-usage-item"><span>模型用量</span><strong>{usage.tokens}</strong></div>
  {usage.showBreakdown && <div className="minutes-usage-item"><span>纪要输入 / 输出</span><strong>{usage.input} / {usage.output}</strong></div>}
  {usage.details && <div className="minutes-usage-item"><strong>{usage.details}</strong></div>}
 </footer>;
}

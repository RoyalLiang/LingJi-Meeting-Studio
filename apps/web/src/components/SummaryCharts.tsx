import type { Evidence, Minutes } from '../model';
import { MinutesVisuals } from './MinutesVisuals';
export function SummaryCharts({ minutes, cite }: { minutes: Minutes; cite: (evidence: Evidence) => void }) {
  return minutes.visuals?.length ? <section className="summary-charts" aria-label="会议时间与数据"><MinutesVisuals visuals={minutes.visuals}/></section> : <p className="fine-print">没有已确认的时间节点或可比较数据时，保留文字与表格。</p>;
}

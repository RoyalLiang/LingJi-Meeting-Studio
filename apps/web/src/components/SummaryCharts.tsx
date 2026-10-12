import type { Minutes } from '../model';
import { TopicMap } from './TopicMap';
import { decisionItems } from '../minutes-views';
export function SummaryCharts({ minutes }: { minutes: Minutes }) {
  const counts = [{label:'讨论主题',value:minutes.topics?.length || 0},{label:'明确决策',value:decisionItems(minutes).length},{label:'行动候选',value:minutes.actions.length}];
  const max = Math.max(1,...counts.map(item=>item.value));
  return <section className="summary-charts" aria-label="总结图表"><h4>纪要条目分布</h4><p className="fine-print">仅统计本版已提取条目，行动仍需人工确认。</p><dl>{counts.map(item=><div key={item.label}><dt>{item.label}</dt><dd><span className="summary-count-track"><span style={{width:`${item.value/max*100}%`}}/></span><b>{item.value}</b></dd></div>)}</dl><h4>主题引用覆盖</h4><TopicMap minutes={minutes}/></section>;
}

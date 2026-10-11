import { useState } from 'react';
import { Lightbulb } from '@phosphor-icons/react';
import type { Evidence, RecordDetail, Segment } from '../model';
import { Button, Status } from './ui';
const labels: Record<string,string> = {decision:'决定',action:'行动候选',proposal:'提议',question:'问题',withdrawal:'否定 / 撤回'};
export function Insights({record,cite,analyze,modelReady}: {record: RecordDetail; analyze:()=>void;modelReady:boolean; cite: (ref: Evidence,snapshot?: Segment[]) => void}) {
  const [filter,setFilter] = useState('all'), data = record.insights;
  if (!record.segments.length) return null;
  return <section className="insights"><header className="section-title"><Lightbulb size={20}/><h2>讨论脉络</h2><Button disabled={!modelReady} onClick={analyze}>使用模型分析</Button><Status>{data?.method === 'model' ? 'AI 分析' : '本地规则提示'}</Status></header>
    {(!data || data.transcriptRevision !== record.transcriptRevision) && <p className="fine-print">{record.intentError ? '分析暂未完成，转录已保存，稍后重试。' : '正在整理最新转录；已有提示可能来自旧版本。'}</p>}
    {data && <><div className="filter-tabs" role="group" aria-label="意图类型筛选">{[['all','全部'],...Object.entries(labels)].map(([kind,label]) => <button key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{label}<small>{data.items.filter(i => kind === 'all' || i.kind === kind).length}</small></button>)}</div>
      <div className="insight-list">{data.items.filter(i => filter === 'all' || i.kind === filter).map((item,index) => <div className={`insight-item ${item.kind}`} key={index}><Status>{labels[item.kind]}</Status><div><p>{item.text}</p><div className="citations">{item.evidence.map((ref,i) => <button key={i} onClick={() => cite(ref, data.evidenceSnapshot)}>来源 {i+1}</button>)}</div></div></div>)}{!data.items.some(i => filter === 'all' || i.kind === filter) && <p className="fine-print">暂未提取到明确的{filter === 'all' ? '讨论意图' : labels[filter]}。</p>}</div>
      <p className="fine-print">仅分析最近 120 个片段，保留版本引用。{data.method === 'rules' ? '当前为保守规则提示，配置纪要模型后，可点击使用模型分析，将转录发送到已配置服务。' : 'AI 判断需要结合原文核对。'}行动候选不会自动执行。</p></>}
  </section>;
}

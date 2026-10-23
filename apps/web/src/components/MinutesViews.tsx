import { useMemo, useState } from 'react';
import { CaretDown, CheckCircle, UsersThree, TreeStructure } from '@phosphor-icons/react';
import type { Evidence, Minutes, MinutesItem } from '../model';
import { decisionItems, speakerViews, topicTableLayout } from '../minutes-views';
import { SummaryTables } from './SummaryTables';
import { MinutesVisuals } from './MinutesVisuals';
import './minutes-tree.css';
import { Button, Empty } from './ui';
import { CitationSources as Sources } from './CitationSources';

type Props = { minutes: Minutes; cite: (evidence: Evidence) => void };
const kindLabels = { fact: '要点', decision: '已明确', action: '下一步', risk: '风险', question: '待确认' };
function Point({ item, cite }: { item: MinutesItem; cite: Props['cite'] }) {
  return <div className="branch-node" data-kind={item.kind || 'fact'}><p>{(item.label || (item.kind && item.kind !== 'fact')) && <strong className="point-label">{item.label || kindLabels[item.kind || 'fact']}<span aria-hidden="true"> · </span></strong>}{item.text}</p><Sources compact evidence={item.evidence} cite={cite}/></div>;
}
function Branch({ branch, index, minutes, cite }: { branch: ReturnType<typeof topicTableLayout>['branches'][number]; index: number; minutes: Minutes; cite: Props['cite'] }) {
  const [expanded, setExpanded] = useState(true);
  const keyPoints = branch.items.filter(item => item.kind && item.kind !== 'fact');
  const details = branch.items.filter(item => !item.kind || item.kind === 'fact');
  const visuals = (minutes.visuals || []).filter(visual => branch.id && visual.topicId === branch.id);
  return <section className="minutes-branch" data-tone={index % 4}>
    <h4><Button variant="ghost" className="branch-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><CaretDown size={15} className={expanded ? '' : 'collapsed'}/><span>{branch.title}</span><small>{String(index + 1).padStart(2, '0')}</small></Button></h4>
    {expanded && <div className="branch-children">{branch.summary && <div className="branch-node branch-summary"><p>{branch.summary}</p><Sources compact evidence={branch.evidence} cite={cite}/></div>}
      <MinutesVisuals visuals={visuals} cite={cite}/>
      {[...keyPoints, ...details.slice(0, 2)].map((item, i) => <Point key={i} item={item} cite={cite}/>)}
      {details.length > 2 && <details className="branch-detail"><summary>展开 {details.length - 2} 条讨论细节</summary><div>{details.slice(2).map((item, i) => <Point key={i} item={item} cite={cite}/>)}</div></details>}
      {branch.tables.length > 0 && <div className="branch-node branch-table"><SummaryTables minutes={minutes} tables={branch.tables} cite={cite}/></div>}
    </div>}
  </section>;
}
export function MinutesTree({ minutes, cite }: Props) {
  const branches = useMemo(() => {
    const layout = topicTableLayout(minutes);
    return layout.unassigned.length ? [...layout.branches, { title: '补充表格', summary: '', evidence: [], items: [], tables: layout.unassigned }] : layout.branches;
  }, [minutes]);
  const unassignedVisuals = (minutes.visuals || []).filter(visual => !visual.topicId || !branches.some(branch => branch.id === visual.topicId));
  return branches.length || minutes.highlights?.length || unassignedVisuals.length ? <div className="minutes-reading">
    {Boolean(minutes.highlights?.length) && <section className="minutes-highlights" aria-label="重点速览"><h4>重点速览</h4><ul>{minutes.highlights!.map((item, index) => <li key={index}><p>{item.text}</p><Sources compact evidence={item.evidence} cite={cite}/></li>)}</ul></section>}
    <div className="minutes-tree is-compact" aria-label="按主题整理的纪要">{branches.map((branch, index) => <Branch key={branch.id || `${index}:${branch.title}`} branch={branch} index={index} minutes={minutes} cite={cite}/>)}</div>
    <MinutesVisuals visuals={unassignedVisuals} cite={cite}/>
  </div> : <Empty icon={<TreeStructure size={28}/>} title="尚无可展示的主题">整理完成后将在这里显示。</Empty>;
}

export function SpeakerMinutes({ minutes, cite }: Props) {
  const speakers = speakerViews(minutes);
  return speakers.length ? <div className="speaker-summaries">{speakers.map((speaker, index) => <section className="speaker-summary" key={speaker.speakerId || speaker.speaker}><header><span className="avatar">{speaker.speaker.match(/\d+$/)?.[0] || index + 1}</span><h4>{speaker.speaker}</h4><small>{speaker.method === 'summary' ? 'AI 发言总结' : '原文摘录'}</small></header>{speaker.method === 'extract' && <p className="fine-print">当前版本未提供发言总结，以下为已确认归属的原文。</p>}<p className="speaker-summary-text">{speaker.summary}</p><Sources evidence={speaker.evidence} cite={cite}/></section>)}</div>
    : <Empty icon={<UsersThree size={28}/>} title="等待说话人信息">有可靠归属的发言后，再生成发言人总结。</Empty>;
}
export function DecisionMinutes({ minutes, cite }: Props) {
  const decisions = decisionItems(minutes);
  return decisions.length ? <ol className="decision-list">{decisions.map((decision, index) => <li key={index}><span className="decision-number">{String(index + 1).padStart(2, '0')}</span><div><p>{decision.text}</p><Sources evidence={decision.evidence} cite={cite}/></div></li>)}</ol>
    : <Empty icon={<CheckCircle size={28}/>} title="尚无明确决策">提议与待确认事项保留在主题纪要中。</Empty>;
}

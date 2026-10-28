import { useMemo } from 'react';
import { CheckCircle, UsersThree, TreeStructure } from '@phosphor-icons/react';
import type { Evidence, Minutes, MinutesItem } from '../model';
import { decisionItems, speakerViews, topicTableLayout, speakerLabels } from '../minutes-views';
import { SummaryTables } from './SummaryTables';
import { MinutesVisuals } from './MinutesVisuals';
import './minutes-tree.css';
import { Empty } from './ui';
import { CitationSources as Sources } from './CitationSources';

type Props = { speakerMap?: Map<string,string>; minutes: Minutes; cite: (evidence: Evidence) => void };
const kindLabels = { fact: '要点', decision: '已明确', action: '下一步', risk: '风险', question: '待确认' };
export function MinuteSpeakers({ evidence, speakers }: { evidence: Evidence[]; speakers: Map<string,string> }) {
  const labels=[...new Set(evidence.map(ref=>speakers.get(`${ref.segmentId}:${ref.revision}`) || '来源待核对'))];
  return <span className="minute-speakers" aria-label="说话人" title={labels.includes('未区分说话人')?'转录未提供可核实的说话人身份，可在逐字记录中标注或使用支持说话人区分的服务。':undefined}>{labels.join('、') || '未区分说话人'}</span>;
}
function Point({ item, cite, speakers }: { item: MinutesItem; cite: Props['cite']; speakers: Map<string,string> }) {
  return <div className="branch-node" data-kind={item.kind || 'fact'}><MinuteSpeakers evidence={item.evidence} speakers={speakers}/><p>{(item.label || (item.kind && item.kind !== 'fact')) && <strong className="point-label">{item.label || kindLabels[item.kind || 'fact']}<span aria-hidden="true"> · </span></strong>}{item.text}</p><Sources compact evidence={item.evidence} cite={cite}/></div>;
}
function Branch({ branch, index, minutes, cite, speakers }: { branch: ReturnType<typeof topicTableLayout>['branches'][number]; index: number; minutes: Minutes; cite: Props['cite']; speakers: Map<string,string> }) {
  const keyPoints = branch.items.filter(item => item.kind && item.kind !== 'fact');
  const details = branch.items.filter(item => !item.kind || item.kind === 'fact');
  const visuals = (minutes.visuals || []).filter(visual => branch.id && visual.topicId === branch.id);
  return <section className="minutes-branch" data-tone={index % 4}>
    <h4><span>{branch.title}</span><small>{String(index + 1).padStart(2, '0')}</small></h4>
    <div className="branch-children">{branch.summary && <div className="branch-node branch-summary"><MinuteSpeakers evidence={branch.evidence} speakers={speakers}/><p>{branch.summary}</p><Sources compact evidence={branch.evidence} cite={cite}/></div>}
      <MinutesVisuals visuals={visuals} cite={cite}/>
      {[...keyPoints, ...details].map((item, i) => <Point key={i} item={item} cite={cite} speakers={speakers}/>)}
      {branch.tables.length > 0 && <div className="branch-node branch-table"><SummaryTables minutes={minutes} tables={branch.tables} cite={cite}/></div>}
    </div>
  </section>;
}
export function MinutesTree({ minutes, cite, speakerMap }: Props) {
  const speakers=useMemo(()=>speakerMap || speakerLabels(minutes.evidenceSnapshot || []),[minutes,speakerMap]);
  const branches = useMemo(() => {
    const layout = topicTableLayout(minutes);
    return layout.unassigned.length ? [...layout.branches, { title: '补充表格', summary: '', evidence: [], items: [], tables: layout.unassigned }] : layout.branches;
  }, [minutes]);
  const unassignedVisuals = (minutes.visuals || []).filter(visual => !visual.topicId || !branches.some(branch => branch.id === visual.topicId));
  return branches.length || minutes.highlights?.length || unassignedVisuals.length ? <div className="minutes-reading">
    {Boolean(minutes.highlights?.length) && <section className="minutes-highlights" aria-label="重点速览"><h4>重点速览</h4><ul>{minutes.highlights!.map((item, index) => <li key={index}><MinuteSpeakers evidence={item.evidence} speakers={speakers}/><p>{item.text}</p><Sources compact evidence={item.evidence} cite={cite}/></li>)}</ul></section>}
    <div className="minutes-tree is-compact" aria-label="按主题整理的纪要">{branches.map((branch, index) => <Branch key={branch.id || `${index}:${branch.title}`} branch={branch} index={index} minutes={minutes} cite={cite} speakers={speakers}/>)}</div>
    <MinutesVisuals visuals={unassignedVisuals} cite={cite}/>
  </div> : <Empty icon={<TreeStructure size={28}/>} title="尚无可展示的主题">整理完成后将在这里显示。</Empty>;
}

export function SpeakerMinutes({ minutes, cite }: Props) {
  const speakers = speakerViews(minutes);
  return speakers.length ? <div className="speaker-summaries">{speakers.map((speaker, index) => <section className="speaker-summary" key={speaker.speakerId || speaker.speaker}><header><span className="avatar">{speaker.speaker.match(/\d+$/)?.[0] || index + 1}</span><h4>{speaker.speaker}</h4><small>{speaker.method === 'summary' ? 'AI 发言总结' : '原文摘录'}</small></header>{speaker.method === 'extract' && <p className="fine-print">当前版本未提供发言总结，以下为已确认归属的原文。</p>}<p className="speaker-summary-text">{speaker.summary}</p><Sources evidence={speaker.evidence} cite={cite}/></section>)}</div>
    : <Empty icon={<UsersThree size={28}/>} title="等待说话人信息">有可靠归属的发言后，再生成发言人总结。</Empty>;
}
export function DecisionMinutes({ minutes, cite, speakerMap }: Props) {
  const decisions = decisionItems(minutes), speakers=speakerMap || speakerLabels(minutes.evidenceSnapshot || []);
  return decisions.length ? <ol className="decision-list">{decisions.map((decision, index) => <li key={index}><span className="decision-number">{String(index + 1).padStart(2, '0')}</span><div><MinuteSpeakers evidence={decision.evidence} speakers={speakers}/><p>{decision.text}</p><Sources evidence={decision.evidence} cite={cite}/></div></li>)}</ol>
    : <Empty icon={<CheckCircle size={28}/>} title="尚无明确决策">提议与待确认事项保留在主题纪要中。</Empty>;
}

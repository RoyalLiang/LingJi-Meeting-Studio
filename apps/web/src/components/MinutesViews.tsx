import { memo, useMemo } from 'react';
import { CheckCircle, UsersThree, TreeStructure } from '@phosphor-icons/react';
import type { Evidence, Minutes, MinutesItem } from '../model';
import { decisionItems, speakerViews, topicTableLayout, speakerLabels } from '../minutes-views';
import { SummaryTables } from './SummaryTables';
import { MinutesVisuals } from './MinutesVisuals';
import './minutes-tree.css';
import { Empty } from './ui';
import { MinuteSpeakers } from './MinuteSpeakers';

type Props = { showHighlights?: boolean; speakerMap?: Map<string,string>; minutes: Minutes; cite: (evidence: Evidence) => void };
import { minutesKindLabels as kindLabels, minutesStateLabel } from '../../../../packages/records/src/minutes-quality.mjs';
export { MinuteSpeakers } from './MinuteSpeakers';

function Point({ item, speakers }: { item: MinutesItem; speakers: Map<string,string> }) {
  const state=minutesStateLabel(item),labels=[state,item.label||(!state&&item.kind&&item.kind!=='fact'?kindLabels[item.kind]:undefined)].filter(Boolean);
  const label=[...new Set(labels)].join(' · ');
  return <div className="branch-point" data-kind={item.kind || 'fact'}><MinuteSpeakers evidence={item.evidence} speakers={speakers}/><p>{label && <strong className="point-label">{label}<span aria-hidden="true"> · </span></strong>}{item.text}</p></div>;
}
function Branch({ branch, index, minutes, cite, speakers }: { branch: ReturnType<typeof topicTableLayout>['branches'][number]; index: number; minutes: Minutes; cite: Props['cite']; speakers: Map<string,string> }) {
  const groups = new Map<string, MinutesItem[]>();
  for (const item of branch.items) {
    const key = item.kind || 'fact';
    const group=groups.get(key) || []; group.push(item); groups.set(key,group);
  }
  const visuals = (minutes.visuals || []).filter(visual => branch.id && visual.topicId === branch.id);
  return <section className="minutes-branch" data-tone={index % 4}>
    <h4><span>{branch.title}</span><small>{String(index + 1).padStart(2, '0')}</small></h4>
    <div className="branch-children">{branch.summary && <div className="branch-node branch-summary"><MinuteSpeakers evidence={branch.evidence} speakers={speakers}/><p>{branch.summary}</p></div>}
      {[...groups].map(([kind,items]) => <div className="branch-node branch-points" key={kind} data-kind={kind}>{items.map((item,index)=><Point key={index} item={item} speakers={speakers}/>)}</div>)}
    </div>
    {(visuals.length > 0 || branch.tables.length > 0) && <div className="branch-content"><MinutesVisuals visuals={visuals}/>{branch.tables.length > 0 && <SummaryTables minutes={minutes} tables={branch.tables} speakerMap={speakers}/>}</div>}
  </section>;
}
export const MinutesTree=memo(function MinutesTree({ minutes, cite, speakerMap, showHighlights = true }: Props) {
  const speakers=useMemo(()=>speakerMap || speakerLabels(minutes.evidenceSnapshot || []),[minutes,speakerMap]);
  const branches = useMemo(() => {
    const layout = topicTableLayout({...minutes,sections:minutes.sections.map(section=>({...section,items:section.items.filter(item=>item.label!=='过程记录')}))});
    return layout.unassigned.length ? [...layout.branches, { title: '补充表格', summary: '', evidence: [], items: [], tables: layout.unassigned }] : layout.branches;
  }, [minutes]).filter(branch=>Boolean(branch.summary?.trim() || branch.items.length || branch.tables.length || (minutes.visuals||[]).some(visual=>branch.id&&visual.topicId===branch.id)));
  const unassignedVisuals = (minutes.visuals || []).filter(visual => !visual.topicId || !branches.some(branch => branch.id === visual.topicId));
  return branches.length || minutes.highlights?.length || unassignedVisuals.length ? <div className="minutes-reading">
    {Boolean(showHighlights && minutes.highlights?.length) && <section className="minutes-highlights" aria-label="重点速览"><h4>重点速览</h4><ul>{minutes.highlights!.map((item, index) => <li key={index}><MinuteSpeakers evidence={item.evidence} speakers={speakers}/><p>{item.text}</p></li>)}</ul></section>}
    <div className="minutes-tree is-compact" aria-label="按主题整理的纪要">{branches.map((branch, index) => <Branch key={branch.id || `${index}:${branch.title}`} branch={branch} index={index} minutes={minutes} cite={cite} speakers={speakers}/>)}</div>
    <MinutesVisuals visuals={unassignedVisuals}/>
  </div> : <Empty icon={<TreeStructure size={28}/>} title="尚无可展示的主题">整理完成后将在这里显示。</Empty>;
});

export function SpeakerMinutes({ minutes, cite, speakerMap }: Props) {
  const speakers = speakerViews(minutes),labels=speakerMap||speakerLabels(minutes.evidenceSnapshot||[]);
  return speakers.length ? <div className="speaker-summaries">{speakers.map((speaker, index) => <section className="speaker-summary" key={speaker.speakerId || speaker.speaker}><header><span className="avatar">{speaker.speaker.match(/\d+$/)?.[0] || index + 1}</span><h4>{labels.get(`${speaker.evidence[0]?.segmentId}:${speaker.evidence[0]?.revision}`)||speaker.speaker}</h4><small>{speaker.method === 'summary' ? 'AI 发言总结' : '原文摘录'}</small></header>{speaker.method === 'extract' && <p className="fine-print">当前版本未提供发言总结，以下为已确认归属的原文。</p>}<p className="speaker-summary-text">{speaker.summary}</p></section>)}</div>
    : <Empty icon={<UsersThree size={28}/>} title="等待说话人信息">有可靠归属的发言后，再生成发言人总结。</Empty>;
}
export function DecisionMinutes({ minutes, cite, speakerMap }: Props) {
  const decisions = decisionItems(minutes), speakers=speakerMap || speakerLabels(minutes.evidenceSnapshot || []);
  return decisions.length ? <ol className="decision-list">{decisions.map((decision, index) => <li key={index}><span className="decision-number">{String(index + 1).padStart(2, '0')}</span><div><MinuteSpeakers evidence={decision.evidence} speakers={speakers}/><p>{decision.text}</p></div></li>)}</ol>
    : <Empty icon={<CheckCircle size={28}/>} title="尚无明确决策">提议与待确认事项保留在主题纪要中。</Empty>;
}

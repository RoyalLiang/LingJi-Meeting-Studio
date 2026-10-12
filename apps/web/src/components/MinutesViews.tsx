import { useState } from 'react';
import { CaretDown, CheckCircle, UsersThree, TreeStructure } from '@phosphor-icons/react';
import type { Evidence, Minutes } from '../model';
import { decisionItems, speakerViews, topicBranches } from '../minutes-views';
import { Button, Empty } from './ui';

type Props = { minutes: Minutes; cite: (evidence: Evidence) => void };
function Sources({ evidence, cite }: { evidence: Evidence[]; cite: Props['cite'] }) {
  const unique = evidence.filter((ref, index) => evidence.findIndex(item => item.segmentId === ref.segmentId && item.revision === ref.revision) === index);
  return <div className="citations">{unique.map((ref, index) => <button key={`${ref.segmentId}:${ref.revision}`} onClick={() => cite(ref)} aria-label={`查看引用原文 ${index + 1}`}>来源 {index + 1}</button>)}</div>;
}
function Branch({ branch, index, cite }: { branch: ReturnType<typeof topicBranches>[number]; index: number; cite: Props['cite'] }) {
  const [expanded, setExpanded] = useState(true);
  return <section className="minutes-branch" data-tone={index % 4}>
    <h4><Button variant="ghost" className="branch-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><CaretDown size={15} className={expanded ? '' : 'collapsed'}/><span>{branch.title}</span><small>{String(index + 1).padStart(2, '0')}</small></Button></h4>
    {expanded && <div className="branch-children">{branch.summary && <div className="branch-node"><p>{branch.summary}</p><Sources evidence={branch.evidence} cite={cite}/></div>}{branch.items.map((item, i) => <div className="branch-node" key={i}><p>{item.text}</p><Sources evidence={item.evidence} cite={cite}/></div>)}</div>}
  </section>;
}
export function MinutesTree({ minutes, cite }: Props) {
  const branches = topicBranches(minutes);
  return branches.length ? <div className="minutes-tree" aria-label="按主题整理的纪要">{branches.map((branch, index) => <Branch key={`${index}:${branch.title}`} branch={branch} index={index} cite={cite}/>)}</div>
    : <Empty icon={<TreeStructure size={28}/>} title="主题正在形成">有可用转录后，讨论将按主题整理。</Empty>;
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

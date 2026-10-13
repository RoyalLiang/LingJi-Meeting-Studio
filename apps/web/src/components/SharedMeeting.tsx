import { useState } from 'react';
import type { Evidence, Minutes, Segment } from '../model';
import { timecode } from '../model';
import type { CitationSelection } from '../citation-context';
import { Brand } from './Brand';
import { CitationContext } from './CitationContext';
import { CitationSources } from './CitationSources';
import { MinutesTree, DecisionMinutes } from './MinutesViews';
import './SharedMeeting.css';

export interface SharedMeetingData { title: string; minutes: Minutes | null; segments?: Segment[]; draft?: boolean }

export function SharedMeeting({ data, error }: { data?: SharedMeetingData; error: string }) {
  const [selection, setSelection] = useState<CitationSelection | null>(null);
  const cite = (reference: Evidence) => { if (data?.minutes) setSelection({ reference, snapshot: data.minutes.evidenceSnapshot, transcriptRevision: data.minutes.transcriptRevision }); };
  return <main className="shared-page glass shared-meeting"><Brand/><p className="kicker">只读会议分享</p>{error ? <p role="alert">{error}</p> : !data ? <p role="status">正在读取分享…</p> : <>
    <header className="shared-meeting-heading"><h1>{data.title}</h1><span>{data.draft ? '纪要草稿 · ' : ''}刷新以查看最新内容</span></header>
    {data.minutes ? <>
      <MinutesTree minutes={data.minutes} cite={cite}/>
      {Boolean(data.minutes.decisions?.length) && <section className="shared-meeting-section"><h2>关键决策</h2><DecisionMinutes minutes={data.minutes} cite={cite}/></section>}
      {data.minutes.actions.length > 0 && <section className="shared-meeting-section"><h2>行动事项</h2><ul>{data.minutes.actions.map((action, index) => <li key={index}><p>{action.text}</p>{(action.owner || action.due) && <small>{[action.owner, action.due].filter(Boolean).join(' · ')}</small>}<CitationSources evidence={action.evidence} cite={cite}/></li>)}</ul></section>}
    </> : <p className="muted">纪要生成后会显示在这里。</p>}
    {data.segments && <details className="shared-meeting-transcript"><summary>全部转录<span>{data.segments.length} 段</span></summary><ol>{data.segments.map(segment => <li key={segment.id}><div><b>{segment.speaker || '未标注说话人'}</b><time>{timecode(segment.startMs)}–{timecode(segment.endMs)}</time></div><p>{segment.text}</p></li>)}</ol></details>}
  </>}{selection && <CitationContext selection={selection} close={() => setSelection(null)}/>}</main>;
}

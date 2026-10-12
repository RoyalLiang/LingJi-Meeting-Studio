import { ChatCircleDots } from '@phosphor-icons/react';
import type { Evidence, Job, Minutes, RecordDetail, Segment } from '../model';

export function CurrentDiscussion({ record, minutes, job, cite }: { record: RecordDetail; minutes: Minutes | null; job?: Job; cite: (ref: Evidence, snapshot?: Segment[]) => void }) {
  const excerpt = (text: string) => [...text].length > 160 ? `${[...text].slice(0,160).join('')}…` : text;
  const live = record.capture !== 'completed';
  const preview = ['queued', 'running'].includes(job?.status || '') ? job?.preview?.filter(block => block.kind !== 'title' && block.kind !== 'heading').slice(-4) : [];
  const covered = new Set((minutes?.evidenceSnapshot || []).map(segment => `${segment.id}:${segment.revision}`));
  const pending = record.segments.filter(segment => !covered.has(`${segment.id}:${segment.revision}`)).slice(-3);
  const drafts = record.sources.flatMap(source => source.asr?.preview?.text ? [{text:source.asr.preview.text}] : []);
  const structured = minutes?.currentDiscussion || [];
  const recent = record.segments.slice(-3);
  const raw = pending.length ? pending : !structured.length ? recent : [];
  return <section className="current-discussion" aria-label={live ? '当前正在聊' : '最后讨论'}><header><div><ChatCircleDots size={20}/><h3>{live ? '当前正在聊…' : '最后讨论'}</h3></div><span className="discussion-status">{preview?.length ? 'AI 正在归纳 · 草稿' : pending.length || drafts.length ? '新发言 · 待归纳' : structured.length ? '已归纳要点' : '原文速览'}</span></header>
    {preview?.length ? <ol>{preview.map((block, i) => <li key={i}><p>{block.text}</p></li>)}</ol> : <>
      {raw.length ? <ol>{raw.map(segment => <li key={segment.id}><p>{segment.speaker && <b>{segment.speaker}：</b>}{excerpt(segment.text)}</p><div className="citations"><button onClick={() => cite({segmentId:segment.id,revision:segment.revision},record.segments)}>查看完整原文</button></div></li>)}</ol> : structured.length ? <ol>{structured.map((item, i) => <li key={i}><p>{item.text}</p><div className="citations">{item.evidence.map((ref, j) => <button key={j} onClick={() => cite(ref,minutes?.evidenceSnapshot)}>来源 {j + 1}</button>)}</div></li>)}</ol> : null}
      {drafts.map((draft, i) => <p className="discussion-draft" key={i}><span className="live-dot"/>{draft.text}<small>识别草稿</small></p>)}
      {!raw.length && !structured.length && !drafts.length && <p className="muted">{live ? '对话开始后，这里持续显示新发言与正在形成的要点。' : '本场尚无可用发言。'}</p>}
    </>}
    {preview?.length ? <p className="fine-print">完整结果核验后进入上方纪要，草稿暂不作为结论引用。</p> : null}
  </section>;
}

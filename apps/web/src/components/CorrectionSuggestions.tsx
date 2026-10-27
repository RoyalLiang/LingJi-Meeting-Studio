import { useEffect, useRef, useState } from 'react';
import { BookOpenText } from '@phosphor-icons/react';
import { api, messageOf } from '../api';
import { timecode, type RecordDetail } from '../model';
import { Button } from './ui';

type Candidate = { segmentId: string; revision: number; start: number; original: string; replacement: string; method: string };
type Review = { candidates: Candidate[]; fingerprint: string; reviewedSegments: number; totalSegments: number };
export function CorrectionSuggestions({ record, changed }: { record: RecordDetail; changed: () => void }) {
  const [review, setReview] = useState<Review | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function check(model: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try { const result = await api<Review>(`/records/${record.id}/corrections${model ? '/model' : ''}`, model ? 'POST' : 'GET'); if (active.current) setReview(result); }
    catch (e) { if (active.current) setMessage(messageOf(e)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function accept(candidate: Candidate, changes?: Candidate[]) {
    if (!review || pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const result = await api<RecordDetail>(`/records/${record.id}/corrections`, 'POST', {...candidate,changes,fingerprint:review.fingerprint});
      if (active.current) {
        const segment = result.segments.find(s => s.id === candidate.segmentId)!, applied = changes || [candidate];
        setReview(current => current ? {...current,candidates:current.candidates.flatMap(c => {
          if (c.segmentId !== candidate.segmentId) return [c];
          if (applied.some(a => c.start < a.start+a.original.length && a.start < c.start+c.original.length)) return [];
          const start = c.start+applied.filter(a => a.start < c.start).reduce((n,a) => n+a.replacement.length-a.original.length,0);
          return segment.text.slice(start,start+c.original.length) === c.original ? [{...c,start,revision:segment.revision}] : [];
        })} : current); changed();
      }
    } catch (e) { if (active.current) setMessage(messageOf(e)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const candidates = review?.candidates.filter(c => record.segments.some(s => s.id === c.segmentId && s.revision === c.revision && (!s.edited || s.correction?.revision === s.revision))) || [];
  return <section className="correction-review" aria-label="词表辅助纠错"><div className="actions"><BookOpenText size={18}/><Button disabled={busy} onClick={() => void check(false)}>检查词表纠错</Button><Button variant="ghost" disabled={busy} onClick={() => void check(true)}>使用模型检查（发送原文与词表）</Button>{busy && <span role="status">正在检查…</span>}</div>
    {message && <p className="inline-error" role="alert">{message}</p>}
    {review && !candidates.length && <p role="status">没有待确认候选。可在设置中补充词语、名称和误识别写法。</p>}
    {review && review.totalSegments > review.reviewedSegments && <p>本次检查最近 {review.reviewedSegments} 段，共 {review.totalSegments} 段。</p>}
    {candidates.map((candidate,index) => {
      const segment = record.segments.find(s => s.id === candidate.segmentId)!;
      const group = candidates.filter(c => c.segmentId === candidate.segmentId).sort((a,b) => a.start-b.start);
      const canGroup = group.length > 1 && group[0] === candidate && group.every((c,i) => !i || c.start >= group[i-1].start+group[i-1].original.length);
      return <article className="correction-candidate" key={`${candidate.segmentId}:${candidate.start}:${candidate.replacement}`}><div><span className="muted">{timecode(segment.startMs)} · {candidate.method === 'model' ? '模型候选' : '词表候选'}</span><p>{segment.text.slice(Math.max(0,candidate.start-24),candidate.start)}<del>{candidate.original}</del> → <strong>{candidate.replacement}</strong>{segment.text.slice(candidate.start+candidate.original.length,candidate.start+candidate.original.length+24)}</p></div><div className="actions">{canGroup && <Button disabled={busy} onClick={() => void accept(candidate,group)}>确认本段全部 {group.length} 处</Button>}<Button disabled={busy} onClick={() => void accept(candidate)}>确认替换</Button><Button variant="ghost" disabled={busy} onClick={() => setReview(current => current ? {...current,candidates:current.candidates.filter(c => c !== candidate)} : current)} aria-label={`忽略候选 ${index+1}`}>忽略</Button></div></article>;
    })}
  </section>;
}

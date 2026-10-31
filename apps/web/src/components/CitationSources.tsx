import { useMemo, useState } from 'react';
import { FileText } from '@phosphor-icons/react';
import type { Evidence } from '../model';

export function CitationSources({ evidence, cite, label, compact = false }: { evidence: Evidence[]; cite: (ref: Evidence) => void; label?: (index: number) => string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const unique = useMemo(() => {
    const refs = new Map<string, Evidence>();
    for (const ref of evidence) { const key = `${ref.segmentId}:${ref.revision}`; if (!refs.has(key)) refs.set(key, ref); }
    return [...refs.values()];
  }, [evidence]);
  const visible = expanded ? unique : unique.slice(0, 3);
  if (compact) return <div className="citations is-compact">{unique.length > 0 && <button className="citation-entry" aria-label={`查看 ${unique.length} 处引用原文`} aria-expanded={unique.length > 1 ? expanded : undefined} onClick={() => unique.length === 1 ? cite(unique[0]) : setExpanded(!expanded)} title={`查看 ${unique.length} 处引用原文`}><FileText size={14} aria-hidden="true"/></button>}{expanded && unique.map((ref, index) => <button key={`${ref.segmentId}:${ref.revision}`} onClick={() => cite(ref)} aria-label={label?.(index) || `查看引用原文 ${index + 1}`}>来源 {index + 1}</button>)}</div>;
  return <div className="citations">{visible.map((ref, index) => <button key={`${ref.segmentId}:${ref.revision}`} onClick={event => { event.currentTarget.focus({ preventScroll: true }); cite(ref); }} aria-label={label?.(index) || `查看引用原文 ${index + 1}`}>来源 {index + 1}</button>)}{unique.length > 3 && <button className="citation-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起来源' : `+${unique.length - 3} 条来源`}</button>}</div>;
}

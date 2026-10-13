import { useMemo, useState } from 'react';
import type { Evidence } from '../model';

export function CitationSources({ evidence, cite, label }: { evidence: Evidence[]; cite: (ref: Evidence) => void; label?: (index: number) => string }) {
  const [expanded, setExpanded] = useState(false);
  const unique = useMemo(() => {
    const refs = new Map<string, Evidence>();
    for (const ref of evidence) { const key = `${ref.segmentId}:${ref.revision}`; if (!refs.has(key)) refs.set(key, ref); }
    return [...refs.values()];
  }, [evidence]);
  const visible = expanded ? unique : unique.slice(0, 3);
  return <div className="citations">{visible.map((ref, index) => <button key={`${ref.segmentId}:${ref.revision}`} onClick={() => cite(ref)} aria-label={label?.(index) || `查看引用原文 ${index + 1}`}>来源 {index + 1}</button>)}{unique.length > 3 && <button className="citation-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起来源' : `+${unique.length - 3} 条来源`}</button>}</div>;
}

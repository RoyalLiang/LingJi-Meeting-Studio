import type { ReactNode } from 'react';
export function SearchHighlights({ text, ranges = [] }: { text: string; ranges?: { start: number; end: number }[] }) {
  const parts: ReactNode[] = []; let cursor = 0;
  for (const range of ranges.slice(0, 20)) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < cursor || range.end <= range.start || range.end > text.length) continue;
    parts.push(text.slice(cursor, range.start), <mark className="search-mark" key={range.start}>{text.slice(range.start, range.end)}</mark>); cursor = range.end;
  }
  parts.push(text.slice(cursor)); return <>{parts}</>;
}

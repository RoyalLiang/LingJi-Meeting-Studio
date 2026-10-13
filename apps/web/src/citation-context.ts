import type { Evidence, Segment } from './model';

export interface CitationSelection { reference: Evidence; snapshot: Segment[]; transcriptRevision?: number }

export function citationContext(selection: CitationSelection, radius = 2) {
  const ordered = selection.snapshot.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const index = ordered.findIndex(segment => segment.id === selection.reference.segmentId && segment.revision === selection.reference.revision);
  if (index < 0) return null;
  const extent = Math.max(0, Math.floor(radius));
  const start = Math.max(0, index - extent), end = Math.min(ordered.length, index + extent + 1);
  return { target: ordered[index], segments: ordered.slice(start, end), hasMore: start > 0 || end < ordered.length };
}

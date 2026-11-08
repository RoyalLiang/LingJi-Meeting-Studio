import type { Evidence, Segment, Minutes as MinutesModel, KnowledgeReference } from './model';

export interface CitationSelection { reference: Evidence; snapshot: Segment[]; transcriptRevision?: number }

export function citationContext(selection: CitationSelection, radius = 2) {
  const ordered = selection.snapshot.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const index = ordered.findIndex(segment => segment.id === selection.reference.segmentId && segment.revision === selection.reference.revision);
  if (index < 0) return null;
  const extent = Math.max(0, Math.floor(radius));
  const start = Math.max(0, index - extent), end = Math.min(ordered.length, index + extent + 1);
  return { target: ordered[index], segments: ordered.slice(start, end), hasMore: start > 0 || end < ordered.length };
}

export function knowledgeCitationSelection(reference:KnowledgeReference,minutes:MinutesModel):CitationSelection {
  const evidence=reference.evidence[0],snapshot=minutes.evidenceSnapshot || [];
  if(minutes.revision!==reference.minutesRevision || (minutes.transcriptRevision!=null && minutes.transcriptRevision!==reference.transcriptRevision) || !evidence || !snapshot.some(segment=>segment.id===evidence.segmentId&&segment.revision===evidence.revision))throw new Error('该知识条目的原文版本已不可用，请查看会议中的最新纪要。');
  return {reference:{...evidence},snapshot:structuredClone(snapshot),transcriptRevision:reference.transcriptRevision};
}

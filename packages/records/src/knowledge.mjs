import { digest, requireThat } from './record.mjs';

export const knowledgeKinds = ['decision', 'action', 'risk', 'term'];
export const knowledgeStamp = record => JSON.stringify([record.deleted, record.deleteAt, record.capture, record.workspaceId || null, record.generation, record.transcriptRevision, record.minutesRevision, record.title]);
export const normalizedKnowledgeText = text => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function knowledgeCandidates(record) {
  if (record.deleted || record.capture !== 'completed' || Date.parse(record.deleteAt) <= Date.now() || !record.minutes) return [];
  const minutes = record.minutes;
  const current = new Set(record.segments.map(segment => `${segment.id}:${segment.revision}`));
  const items = [
    ...(minutes.decisions || []).map(item => ({ ...item, kind: 'decision' })),
    ...(minutes.actions || []).map(item => ({ ...item, kind: 'action' })),
    ...(minutes.sections || []).flatMap(section => section.items || []).map(item=>({...item,kind:item.knowledgeKind || item.kind})).filter(item => ['risk', 'decision', 'action', 'term'].includes(item.kind)),
    ...(minutes.terms || []).map(item => ({ ...item, kind: 'term', text: `${item.text}：${item.definition}` })),
  ];
  const seen = new Set();
  return items.filter(item => {
    if (['withdrawn','corrected'].includes(item.status) || !item.text?.trim() || !item.evidence?.length || !item.evidence.every(ref => current.has(`${ref.segmentId}:${ref.revision}`))) return false;
    const key = `${item.kind}:${normalizedKnowledgeText(item.text)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(item => ({
    id: digest(JSON.stringify([record.id, record.generation, record.minutesRevision, item.kind, normalizedKnowledgeText(item.text)])),
    kind: item.kind, text: item.text.trim(), owner: item.owner || '', due: item.due || '',
    topic: minutes.topics?.find(topic => topic.id === item.topicId)?.title || '',
    evidence: item.evidence.map(({ segmentId, revision }) => ({ segmentId, revision })),
    recordId: record.id, title: record.title, workspaceId: record.workspaceId || null,
    generation: record.generation, minutesRevision: record.minutesRevision, transcriptRevision: minutes.transcriptRevision ?? record.transcriptRevision,
    createdAt: record.updatedAt, status: 'candidate', reviewRevision: 0,
  })).map(entry => ({...entry,topicKey:normalizedKnowledgeText(entry.topic),textKey:normalizedKnowledgeText(entry.text)}));
}

export function reviewKnowledge(entry, input) {
  requireThat(entry && entry.status !== 'retracted', 'knowledge_retracted', 409);
  requireThat(['confirmed', 'dismissed', 'candidate'].includes(input.status), 'invalid_knowledge_review', 400);
  requireThat(Number.isSafeInteger(input.revision) && input.revision === entry.reviewRevision, 'knowledge_revision_conflict', 409);
  entry.status = input.status; entry.reviewRevision++; entry.reviewedAt = new Date().toISOString();
  return entry;
}

export function knowledgeHighlight(text, query) {
  const start = text.toLowerCase().indexOf(query.toLowerCase());
  return query && start >= 0 ? [{ start, end: start + query.length }] : [];
}

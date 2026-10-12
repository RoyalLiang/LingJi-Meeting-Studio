import type { Minutes, MinutesItem, SpeakerSummary } from './model';

export function topicBranches(minutes: Minutes) {
  const items = minutes.sections.flatMap(section => section.items);
  if (!minutes.topics?.length) return minutes.sections.map(section => ({ title: section.heading, summary: '', evidence: section.items.flatMap(item => item.evidence), items: section.items }));
  const assigned = new Set<MinutesItem>();
  const branches = minutes.topics.map(topic => {
    const matching = items.filter(item => !assigned.has(item) && item.evidence.some(ref => topic.evidence.some(source => source.segmentId === ref.segmentId && source.revision === ref.revision)));
    matching.forEach(item => assigned.add(item));
    return { ...topic, items: matching.filter(item => item.text !== topic.summary) };
  });
  const other = items.filter(item => !assigned.has(item));
  if (other.length) branches.push({ title: '其他讨论要点', summary: '', evidence: other.flatMap(item => item.evidence), items: other });
  return branches;
}

export function speakerViews(minutes: Minutes): (SpeakerSummary & { method: 'summary' | 'extract' })[] {
  if (minutes.speakerSummaries?.length) return minutes.speakerSummaries.map(summary => ({ ...summary, method: 'summary' }));
  // Legacy minutes have no speaker summaries. Show only actual attributed excerpts.
  const groups = new Map<string, SpeakerSummary & { method: 'extract' }>();
  for (const segment of minutes.evidenceSnapshot || []) {
    if (!segment.speaker) continue;
    const key = segment.speakerId || `label:${segment.speaker}`;
    const group = groups.get(key) || { speakerId: segment.speakerId || null, speaker: segment.speaker, summary: '', evidence: [], method: 'extract' as const };
    if (group.evidence.length < 4) { group.summary += `${group.summary ? '\n' : ''}${segment.text}`; group.evidence.push({ segmentId: segment.id, revision: segment.revision }); }
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function decisionItems(minutes: Minutes): MinutesItem[] {
  return minutes.decisions || minutes.sections.filter(section => /决定|决策|共识/.test(section.heading)).flatMap(section => section.items);
}

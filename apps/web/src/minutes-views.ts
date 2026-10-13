import type { Evidence, Minutes, MinutesItem, SpeakerSummary, SummaryTable } from './model';

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

export function summaryTables(minutes: Minutes): SummaryTable[] {
  if (minutes.tables?.length) return minutes.tables;
  return minutes.actions.length ? [{
    title: '行动候选汇总', columns: ['事项', '负责人', '时间'],
    rows: minutes.actions.map(action => ({
      cells: [action.text, action.owner || '待确认', action.due || '待确认'], evidence: action.evidence,
    })),
  }] : [];
}

/** Keep every row exactly once. Shared or unmatched source revisions stay unassigned. */
export function topicTableLayout(minutes: Minutes) {
  const branches = topicBranches(minutes).map(branch => ({ ...branch, tables: [] as SummaryTable[] }));
  const key = (ref: Evidence) => `${ref.segmentId}:${ref.revision}`;
  const sources = branches.map(branch => new Set([
    ...branch.evidence, ...branch.items.flatMap(item => item.evidence),
  ].map(key)));
  const unassigned: SummaryTable[] = [];
  for (const table of summaryTables(minutes)) {
    const rows = branches.map(() => [] as SummaryTable['rows']);
    const remaining: SummaryTable['rows'] = [];
    for (const row of table.rows) {
      const owners = row.evidence.map(ref => sources.flatMap((refs, index) => refs.has(key(ref)) ? [index] : []));
      const owner = owners[0]?.length === 1 ? owners[0][0] : -1;
      if (owner >= 0 && owners.every(matches => matches.length === 1 && matches[0] === owner)) rows[owner].push(row);
      else remaining.push(row);
    }
    rows.forEach((items, index) => {
      if (items.length) branches[index].tables.push({ ...table, rows: items });
    });
    if (remaining.length || !table.rows.length) unassigned.push({ ...table, rows: remaining });
  }
  return { branches, unassigned };
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

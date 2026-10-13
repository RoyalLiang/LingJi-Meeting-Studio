import type { Evidence, Minutes, MinutesItem, SpeakerSummary, SummaryTable, Topic } from './model';

export function topicBranches(minutes: Minutes): (Topic & { items: MinutesItem[] })[] {
  const items = minutes.sections.flatMap(section => section.items);
  if (!minutes.topics?.length) return minutes.sections.map(section => ({ title: section.heading, summary: '', evidence: section.items.flatMap(item => item.evidence), items: section.items }));
  const firstTopic = new Map<string, number>();
  minutes.topics.forEach((topic, index) => topic.evidence.forEach(ref => {
    const key = `${ref.segmentId}:${ref.revision}`;
    if (!firstTopic.has(key)) firstTopic.set(key, index);
  }));
  const groups = minutes.topics.map(() => [] as MinutesItem[]), other: MinutesItem[] = [];
  for (const item of items) {
    let owner = Infinity;
    for (const ref of item.evidence) owner = Math.min(owner, firstTopic.get(`${ref.segmentId}:${ref.revision}`) ?? Infinity);
    if (owner === Infinity) other.push(item); else groups[owner].push(item);
  }
  const branches = minutes.topics.map((topic, index) => {
    return { ...topic, items: groups[index].filter(item => item.text !== topic.summary) };
  });
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

/** Explicit model ownership keeps a whole table in its topic; legacy rows use exact source revisions. */
export function topicTableLayout(minutes: Minutes) {
  const branches = topicBranches(minutes).map(branch => ({ ...branch, tables: [] as SummaryTable[] }));
  const key = (ref: Evidence) => `${ref.segmentId}:${ref.revision}`;
  const sources = new Map<string, number>();
  const topicIds = new Map<string, number>();
  branches.forEach((branch, index) => {
    if (branch.id) topicIds.set(branch.id, topicIds.has(branch.id) ? -1 : index);
    for (const ref of [...branch.evidence, ...branch.items.flatMap(item => item.evidence)]) {
      const source = key(ref), previous = sources.get(source);
      sources.set(source, previous === undefined || previous === index ? index : -1);
    }
  });
  const unassigned: SummaryTable[] = [];
  for (const table of summaryTables(minutes)) {
    if (table.topicId !== undefined) {
      const owner = topicIds.get(table.topicId) ?? -1;
      if (owner >= 0) branches[owner].tables.push(table); else unassigned.push(table);
      continue;
    }
    const rows = branches.map(() => [] as SummaryTable['rows']);
    const remaining: SummaryTable['rows'] = [];
    for (const row of table.rows) {
      const owner = row.evidence.length ? sources.get(key(row.evidence[0])) ?? -1 : -1;
      if (owner >= 0 && row.evidence.every(ref => sources.get(key(ref)) === owner)) rows[owner].push(row);
      else remaining.push(row);
    }
    rows.forEach((items, index) => {
      if (items.length) branches[index].tables.push({ ...table, rows: items });
    });
    if (remaining.length || !table.rows.length) unassigned.push({ ...table, rows: remaining });
  }
  return { branches, unassigned };
}

export function topicDurations(minutes: Minutes) {
  const segments = new Map((minutes.evidenceSnapshot || []).map(segment => [`${segment.id}:${segment.revision}`, segment]));
  return (minutes.topics || []).map(topic => {
    const intervals = topic.evidence.flatMap(ref => {
      const segment = segments.get(`${ref.segmentId}:${ref.revision}`);
      return segment ? [[segment.startMs, segment.endMs]] : [];
    }).sort((a, b) => a[0] - b[0]);
    let total = 0, end = 0;
    for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
    return total;
  });
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

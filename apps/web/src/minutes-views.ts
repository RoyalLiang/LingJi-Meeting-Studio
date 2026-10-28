import type { Evidence, Minutes, MinutesItem, RecordDetail, SpeakerSummary, SummaryTable, Topic, Segment } from './model';

export function currentMinutesJob(record: Pick<RecordDetail,'capture'|'jobs'|'transcriptRevision'>) {
  const ended=record.capture==='completed' || record.capture==='sealed';
  return record.jobs.filter(job=>job.status!=='cancelled' && (!ended || job.scope!=='live'))
    .filter(job=>!['failed','stale'].includes(job.status) || job.transcriptRevision===record.transcriptRevision || (!ended && job.scope==='live')).at(-1);
}

export function topicBranches(minutes: Minutes): (Topic & { items: MinutesItem[] })[] {
  const items = minutes.sections.flatMap(section => section.items);
  if (!minutes.topics?.length) return minutes.sections.map(section => ({ title: section.heading, summary: '', evidence: section.items.flatMap(item => item.evidence), items: section.items }));
  const key = (ref: Evidence) => `${ref.segmentId}:${ref.revision}`;
  const topics = minutes.topics, groups = topics.map(() => [] as MinutesItem[]), other = new Map<string, MinutesItem[]>();
  const sources = topics.map(topic => new Set(topic.evidence.map(key)));
  for (const section of minutes.sections) for (const item of section.items) {
    let candidates: number[] = [];
    if (item.topicId) candidates = topics.flatMap((topic, index) => topic.id === item.topicId ? [index] : []);
    else {
      candidates = topics.flatMap((topic, index) => topic.title === section.heading ? [index] : []);
      if (candidates.length !== 1) {
        const scores = sources.map(refs => new Set(item.evidence.map(key).filter(ref => refs.has(ref))).size);
        const max = Math.max(0, ...scores);
        candidates = max ? scores.flatMap((score, index) => score === max ? [index] : []) : [];
      }
    }
    if (candidates.length === 1) groups[candidates[0]].push(item); else other.set(section.heading, [...(other.get(section.heading) || []), item]);
  }
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
  const union = (refs: Evidence[]) => [...new Map(refs.map(ref => [key(ref), ref])).values()];
  const branches = topics.map((topic, index) => {
    const unique = new Map<string, MinutesItem>();
    let evidence = [...topic.evidence];
    for (const item of groups[index]) {
      const text = normalize(item.text);
      if (text === normalize(topic.summary)) { evidence = union([...evidence, ...item.evidence]); continue; }
      const previous = unique.get(text);
      unique.set(text, previous ? { ...previous, evidence: union([...previous.evidence, ...item.evidence]) } : { ...item });
    }
    return { ...topic, evidence, items: [...unique.values()] };
  });
  for(const [title,items] of other) branches.push({ title, summary: '', evidence: union(items.flatMap(item => item.evidence)), items });
  return branches;
}

export function summaryTables(minutes: Minutes): SummaryTable[] {
  const tables = minutes.tables || [];
  if (!minutes.actions.length) return tables;
  const hasOwner = minutes.actions.some(action => action.owner?.trim()), hasDue = minutes.actions.some(action => action.due?.trim());
  return [...tables, { title: '行动候选汇总', columns: ['事项', ...(hasOwner ? ['负责人'] : []), ...(hasDue ? ['时间'] : [])], rows: minutes.actions.map(action => ({ cells: [action.text, ...(hasOwner ? [action.owner || '未明确'] : []), ...(hasDue ? [action.due || '未明确'] : [])], evidence: action.evidence })) }];
}

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

export function speakerLabels(snapshot: Segment[], registry: {id:string;hash?:string;label:string}[] = [], current: Segment[] = []) {
  const labels=new Map<string,string>(),used=new Set<number>();
  const numbered=(label:string)=>Number(label.match(/^(?:说话人|发言人|speaker)\s*(\d+)$/i)?.[1])||0;
  const assign=(identity:string,label='',preferred=0)=>{
    const existing=labels.get(identity);if(existing)return existing;
    let number=preferred||numbered(label);if(!number||used.has(number)){number=1;while(used.has(number))number++;}
    used.add(number);const display=`说话人${number}`;labels.set(identity,display);return display;
  };
  registry.forEach((speaker,index)=>{
    const display=assign(speaker.id,speaker.label,numbered(speaker.label)||index+1);
    if(speaker.hash)labels.set(speaker.hash,display);labels.set(`label:${speaker.label}`,display);
  });
  const identity=(segment:Segment)=>{const label=segment.speaker?.trim()||'';return segment.speakerId||segment.speakerHash||(label&&!/^(?:(?:说话人|发言人|speaker)\s*)?(?:未标注|未识别|未知|未区分|unknown|unlabeled)(?:说话人)?$/i.test(label)?`label:${label}`:'');};
  for(const segment of [...current,...snapshot].sort((a,b)=>(a.startMs||0)-(b.startMs||0))){
    const id=identity(segment);if(!id)continue;
    const display=labels.get(id)||labels.get(`label:${segment.speaker?.trim()}`)||assign(id,segment.speaker||'');
    labels.set(id,display);if(segment.speakerHash)labels.set(segment.speakerHash,display);
  }
  const exact=new Map(current.map(segment=>[`${segment.id}:${segment.revision}`,segment]));
  return new Map(snapshot.map(segment=>{
    const key=`${segment.id}:${segment.revision}`,id=identity(segment)||identity(exact.get(key)||segment);
    return [key,labels.get(id)||'未区分说话人'];
  }));
}

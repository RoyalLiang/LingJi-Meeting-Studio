// Keep live input incremental without treating prior summaries as new evidence.
const identity = ref => `${ref.segmentId ?? ref.id}:${ref.revision}`;
const uniqueRefs = refs => [...new Map(refs.map(ref => [identity(ref), ref])).values()];
const textKey = text => String(text || '').trim().replace(/\s+/g, ' ');
function mergeItems(previous = [], incoming = []) {
  const items = new Map();
  for (const item of [...previous, ...incoming]) {
    const key = textKey(item.text), old = items.get(key);
    items.set(key, old ? { ...old, ...item, ...(old.owner && !item.owner ? {owner:old.owner} : {}), ...(old.due && !item.due ? {due:old.due} : {}), evidence: uniqueRefs([...old.evidence, ...item.evidence]) } : { ...item });
  }
  return [...items.values()];
}
export function liveBaseline(record) {
  const previous = record.liveMinutes;
  if (!previous || previous.notesRevision !== record.notesRevision || previous.template === undefined) return null;
  const current = new Set(record.segments.map(identity));
  return previous.evidenceSnapshot?.every(segment => current.has(identity(segment))) ? previous : null;
}
export function liveInput(record, template) {
  const previous = liveBaseline(record);
  if (!previous || previous.template !== template) return record.segments;
  const covered = new Set(previous.evidenceSnapshot.map(identity));
  // Use two minutes of confirmed speech, not two arbitrarily short ASR fragments.
  // All uncovered evidence is still backfilled; this lookback is not a truncation limit.
  const boundary = record.segments.findIndex(segment => !covered.has(identity(segment)));
  const end = boundary < 0 ? record.segments.length : boundary;
  const anchor = record.segments[boundary < 0 ? end - 1 : boundary];
  const timed = Number.isFinite(anchor?.startMs) && Number.isFinite(anchor?.endMs) && anchor.endMs > anchor.startMs;
  const since = (boundary < 0 ? anchor?.endMs : anchor?.startMs) - 120000;
  return record.segments.filter((segment, index) => !covered.has(identity(segment)) || (index < end &&
    (timed ? segment.endMs > since && segment.startMs <= anchor.startMs : index >= Math.max(0, end - 2))));
}
export function minutesContext(previous) {
  if (!previous) return undefined;
  const budget = 12000, bytes = value => Buffer.byteLength(JSON.stringify(value));
  const context = { title: previous.title.slice(0, 100), topics: (previous.topics || []).map(({ id, title }) => ({ id, title })), headings: [] };
  // Stable IDs survive even when unusually long display titles need shortening.
  while (bytes(context) > budget) {
    const longest = context.topics.filter(topic => topic.title.length > 24).sort((a, b) => b.title.length - a.title.length)[0];
    if (!longest) break;
    longest.title = longest.title.slice(0, Math.max(24, longest.title.length - 16));
  }
  for (const heading of new Set(previous.sections.map(section => section.heading))) {
    context.headings.push(heading);
    if (bytes(context) > budget) context.headings.pop();
  }
  for (let index = 0; index < context.topics.length; index++) {
    context.topics[index].summary = (previous.topics[index].summary || '').slice(0, 160);
    if (bytes(context) > budget) delete context.topics[index].summary;
  }
  return context;
}
export function mergeLiveMinutes(previous, incoming, snapshot) {
  const base = previous || { sections: [], topics: [], actions: [], decisions: [], speakerSummaries: [], tables: [], evidenceSnapshot: [] };
  const headings = new Map();
  for (const section of [...base.sections, ...incoming.sections]) headings.set(section.heading, mergeItems(headings.get(section.heading), section.items));
  const sections = [...headings].flatMap(([heading, items]) => Array.from({ length: Math.ceil(items.length / 100) }, (_, index) => ({ heading, items: items.slice(index * 100, (index + 1) * 100) })));
  const topics = base.topics?.map(topic => ({ ...topic })) || [], aliases = new Map();
  for (const topic of incoming.topics || []) {
    const index = topics.findIndex(old => (topic.id && old.id === topic.id) || textKey(old.title) === textKey(topic.title));
    if (index < 0) topics.push({ ...topic });
    else {
      const old = topics[index]; if (topic.id && old.id) aliases.set(topic.id, old.id);
      topics[index] = { ...old, summary: topic.summary || old.summary, evidence: uniqueRefs([...old.evidence, ...topic.evidence]) };
    }
  }
  // Tables and speaker digests are compact views; prose retains the accumulated facts.
  const tables = new Map(base.tables?.map(table => [`${table.topicId}:${table.title}`, table]) || []);
  for (const table of incoming.tables || []) {
    const next = { ...table, topicId: aliases.get(table.topicId) || table.topicId };
    tables.set(`${next.topicId}:${next.title}`, next);
  }
  const speakers = new Map(base.speakerSummaries?.map(speaker => [speaker.speakerId || speaker.speaker, speaker]) || []);
  for (const speaker of incoming.speakerSummaries || []) speakers.set(speaker.speakerId || speaker.speaker, speaker);
  return {
    ...incoming, title: previous?.title || incoming.title, sections, topics,
    actions: mergeItems(base.actions, incoming.actions), decisions: mergeItems(base.decisions, incoming.decisions),
    speakerSummaries: [...speakers.values()], tables: [...tables.values()].slice(-6),
    evidenceSnapshot: uniqueRefs([...base.evidenceSnapshot, ...snapshot])
  };
}

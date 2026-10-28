const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const evidence = values => (values || []).map(value => pick(value, ['segmentId', 'revision']));
const item = value => ({ ...pick(value, ['text', 'topicId', 'label', 'kind']), evidence: evidence(value.evidence) });

export function sharedSegments(segments) {
  return segments.map(segment => pick(segment, ['id', 'revision', 'text', 'speaker', 'speakerId', 'startMs', 'endMs']));
}

// Explicitly serialize the share contract: provider or internal metadata never leaves it.
export function sharedMinutes(minutes) {
  if (!minutes) return null;
  const references = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.segmentId === 'string' && Number.isInteger(value.revision)) references.add(JSON.stringify([value.segmentId, value.revision]));
    for (const item of Object.values(value)) visit(item);
  };
  const output = {
    ...pick(minutes, ['title', 'revision', 'transcriptRevision', 'edited', 'method']),
    sections: (minutes.sections || []).map(section => ({ heading: section.heading, items: section.items.map(item) })),
    actions: (minutes.actions || []).map(value => ({ ...item(value), ...pick(value, ['owner', 'due', 'status']) })),
    evidenceSnapshot: [],
  };
  if (minutes.topics) output.topics = minutes.topics.map(value => ({ ...pick(value, ['id', 'title', 'summary']), evidence: evidence(value.evidence) }));
  if (minutes.tables) output.tables = minutes.tables.map(value => ({ ...pick(value, ['topicId', 'title', 'columns']), rows: value.rows.map(row => ({ cells: row.cells, evidence: evidence(row.evidence) })) }));
  if (minutes.highlights) output.highlights = minutes.highlights.map(item);
  if (minutes.visuals) output.visuals = minutes.visuals.map(value => ({ ...pick(value, ['kind', 'title', 'topicId', 'unit']), entries: value.entries.map(entry => ({ ...pick(entry, ['label', 'text', 'valueText', 'quote']), evidence: evidence(entry.evidence) })) }));
  if (minutes.decisions) output.decisions = minutes.decisions.map(item);
  if (minutes.currentDiscussion) output.currentDiscussion = minutes.currentDiscussion.map(item);
  if (minutes.speakerSummaries) output.speakerSummaries = minutes.speakerSummaries.map(value => ({ ...pick(value, ['speakerId', 'speaker', 'summary']), evidence: evidence(value.evidence) }));
  visit(output);
  output.evidenceSnapshot = sharedSegments((minutes.evidenceSnapshot || []).filter(segment => references.has(JSON.stringify([segment.id, segment.revision]))));
  return output;
}

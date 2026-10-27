import { digest, editSegment, requireThat } from './record.mjs';

export const vocabularyId = (owner, scope) => `vocabulary:${digest(`${owner}:${scope}`)}`;

// One entry per line: correct spelling | known misrecognition | another alias.
export function parseVocabulary(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid_vocabulary', 400);
  const entries = [];
  for (const kind of ['terms', 'names']) {
    const value = input[kind] ?? '';
    requireThat(typeof value === 'string' && value.length <= 12000 && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value), 'invalid_vocabulary', 400);
    for (const line of value.split(/\r?\n/u).map(s => s.trim()).filter(Boolean)) {
      const [text, ...aliases] = [...new Set(line.split('|').map(s => s.trim()).filter(Boolean))];
      requireThat(text && aliases.length <= 8 && [text, ...aliases].every(s => [...s].length <= 50), 'invalid_vocabulary', 400);
      entries.push({ kind, text, aliases });
    }
  }
  requireThat(entries.length <= 200, 'invalid_vocabulary', 400);
  return entries;
}

export function vocabularyHints(entries, context = '', limit = 100) {
  const ranked = entries.map((entry, index) => ({ ...entry, index, score: [entry.text, ...entry.aliases].some(word => context.toLowerCase().includes(word.toLowerCase())) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const words = []; let size = 0;
  for (const { text } of ranked) {
    if (words.includes(text) || size + [...text].length > limit) continue;
    words.push(text); size += [...text].length;
  }
  return words;
}

export function correctionSpan(text, start, original) {
  if (!Number.isSafeInteger(start) || start < 0 || typeof original !== 'string' || !original.trim() || text.slice(start, start + original.length) !== original) return false;
  // Latin aliases must not match inside another word (e.g. Ann in Annual).
  const word = /[\p{Script=Latin}\p{N}_]/u;
  return !(word.test(original[0]) && word.test(text[start - 1] || ''))
    && !(word.test(original.at(-1)) && word.test(text[start + original.length] || ''));
}

export function vocabularyCandidates(segments, entries) {
  const candidates = [], seen = new Set();
  for (const segment of segments) {
    if (segment.edited && segment.correction?.revision !== segment.revision) continue;
    for (const entry of entries) for (const original of entry.aliases) {
      let start = segment.text.indexOf(original);
      while (start >= 0 && candidates.length < 100) {
        const key = `${segment.id}:${start}:${original}:${entry.text}`;
        if (original !== entry.text && correctionSpan(segment.text, start, original) && !seen.has(key)) {
          candidates.push({ segmentId: segment.id, revision: segment.revision, start, original, replacement: entry.text, kind: entry.kind, method: 'alias' }); seen.add(key);
        }
        start = segment.text.indexOf(original, start + original.length);
      }
    }
    if (candidates.length >= 100) break;
  }
  return candidates;
}

export function acceptVocabularyCorrection(record, input, entries) {
  const segment = record.segments.find(s => s.id === input.segmentId);
  requireThat(segment && (!segment.edited || segment.correction?.revision === segment.revision) && segment.revision === input.revision, 'segment_revision_conflict', 409);
  const changes = input.changes ?? [input];
  requireThat(Array.isArray(changes) && changes.length > 0 && changes.length <= 100, 'invalid_correction', 400);
  for (const change of changes) requireThat(change && entries.some(entry => entry.text === change.replacement) && change.replacement !== change.original
    && typeof change.original === 'string' && change.original.length <= 100 && correctionSpan(segment.text, change.start, change.original), 'invalid_correction', 400);
  const ordered = [...changes].sort((a,b) => b.start-a.start);
  requireThat(ordered.every((change,index) => !index || change.start+change.original.length<=ordered[index-1].start), 'invalid_correction', 400);
  let text = segment.text;
  for (const change of ordered) text = text.slice(0,change.start)+change.replacement+text.slice(change.start+change.original.length);
  segment.recognitionText ??= segment.text;
  editSegment(record, segment.id, { revision: input.revision, text });
  segment.correction = { method: 'vocabulary-confirmed', changes: ordered.map(({start,original,replacement}) => ({start,original,replacement})), revision: segment.revision };
}

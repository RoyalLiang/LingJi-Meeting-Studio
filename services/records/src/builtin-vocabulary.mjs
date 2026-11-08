import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = new URL('./data/', import.meta.url);
export const BUILTIN_VOCABULARY_MAX_BYTES = 2_000_000;

export function parseBuiltinVocabulary(bytes, manifest) {
  if (bytes.length > BUILTIN_VOCABULARY_MAX_BYTES || bytes.length !== manifest.bytes
      || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('invalid_builtin_vocabulary_digest');
  const pack = JSON.parse(bytes.toString('utf8'));
  const known = new Set();
  if (manifest.schemaVersion !== 1 || pack.schemaVersion !== 1 || pack.version !== manifest.version
      || !Array.isArray(pack.entries) || pack.entries.length !== manifest.entries || pack.entries.length > 30_000) throw new Error('invalid_builtin_vocabulary');
  const entries = pack.entries.map(entry => {
    if (typeof entry?.text !== 'string' || !['term', 'name'].includes(entry.kind)
        || entry.text.trim() !== entry.text || [...entry.text].length < 2 || [...entry.text].length > 50
        || /[\p{C}|\r\n]/u.test(entry.text)) throw new Error('invalid_builtin_vocabulary_entry');
    const key = normalized(entry.text);
    if (known.has(key)) throw new Error('invalid_builtin_vocabulary_entry');
    known.add(key);
    const frequency = entry.frequency ?? 1;
    if (!Number.isSafeInteger(frequency) || frequency < 1 || frequency > 1_000_000) throw new Error('invalid_builtin_vocabulary_frequency');
    const match = entry.match ?? 'contextual';
    if (!['exact', 'contextual'].includes(match)) throw new Error('invalid_builtin_vocabulary_match');
    return { text: entry.text, kind: entry.kind === 'name' ? 'names' : 'terms', aliases: [], builtin: true, anchors: entry.anchors || [], frequency, match };
  });
  const terms = new Set(entries.filter(e => e.kind === 'terms').map(e => e.text));
  for (const entry of entries) if (!Array.isArray(entry.anchors) || entry.anchors.length > 4
      || entry.anchors.some(anchor => !terms.has(anchor)) || (entry.kind === 'names' && entry.anchors.length)) throw new Error('invalid_builtin_vocabulary_anchors');
  return { available: true, version: pack.version, hash: manifest.sha256, entries, index: indexVocabulary(entries), related: relatedVocabulary(entries) };
}

export async function readBuiltinVocabulary(base = directory) {
  try {
    const manifestBytes = await readFile(new URL('builtin-vocabulary.manifest.json', base));
    if (manifestBytes.length > 8192) throw new Error('invalid_builtin_vocabulary_manifest');
    return parseBuiltinVocabulary(await readFile(new URL('builtin-vocabulary.private.json', base)), JSON.parse(manifestBytes));
  } catch (error) {
    return { available: false, entries: [], hash: '', reason: error.code === 'ENOENT' ? 'not_bundled' : 'invalid_bundle' };
  }
}

let cached;
export const loadBuiltinVocabulary = () => cached ??= readBuiltinVocabulary();
const normalized = text => text.normalize('NFKC').toLowerCase();
const grams = text => new Set(Array.from({length: Math.max(0, text.length - 1)}, (_, i) => text.slice(i, i + 2)));
const ambiguousWords = new Set('at in on as is it we he be no can do us to me am so or if of up hi go mr ms'.split(' '));

export function indexVocabulary(entries) {
  const index = new Map();
  entries.forEach((entry, id) => {
    for (const gram of grams(normalized(entry.text))) {
      if (!index.has(gram)) index.set(gram, []);
      index.get(gram).push(id);
    }
  });
  return index;
}

function relatedVocabulary(entries) {
  const result = new Map();
  entries.forEach((entry, id) => { for (const anchor of entry.anchors) {
    if (!result.has(anchor)) result.set(anchor, []);
    result.get(anchor).push(id);
  } });
  return result;
}

function occurrence(context, word) {
  const latinWord = /[\p{Script=Latin}\p{N}\p{M}_]/u;
  let start = context.indexOf(word);
  while (start >= 0) {
    if (!(latinWord.test(word[0]) && latinWord.test(context[start - 1] || ''))
        && !(latinWord.test(word.at(-1)) && latinWord.test(context[start + word.length] || ''))) return start;
    start = context.indexOf(word, start + 1);
  }
  return -1;
}

function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, changes = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++changes > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return changes + Number(i < a.length || j < b.length) <= 1;
}

// Retrieval supplies spelling references, never replacements or new evidence.
export function selectBuiltinVocabulary(pack, input, { limit = 64, budget = 1400, includeRelated = true } = {}) {
  if (!pack.available || !input?.trim()) return [];
  const bounded = (input.length > 12_000 ? input.slice(0, 1200) + '\n' + input.slice(-10_799) : input).normalize('NFKC');
  const context = normalized(bounded);
  const matches = new Map();
  const positions = new Map();
  for (let i = 0; i < context.length - 1; i++) {
    const gram = context.slice(i, i + 2);
    if (!positions.has(gram)) positions.set(gram, []);
    if (positions.get(gram).length < 16) positions.get(gram).push(i);
  }
  for (const gram of positions.keys()) for (const id of pack.index.get(gram) || []) matches.set(id, (matches.get(id) || 0) + 1);
  const ranked = [], fuzzy = [], exactWords = new Set();
  for (const [id, overlap] of matches) {
    const entry = pack.entries[id], word = normalized(entry.text);
    const exact = overlap < grams(word).size ? -1 : ambiguousWords.has(word) && /^[A-Z]{2,3}$/.test(entry.text) ? occurrence(bounded, entry.text) : occurrence(context, word);
    const score = exact >= 0 ? 100 + Math.min(word.length, 20) : 0;
    const tie = createHash('sha256').update(word).digest('hex');
    if (score) { ranked.push({entry, score, tie}); exactWords.add(entry.text); }
    // Fuzzy retrieval is limited to longer Chinese terms; names require an exact mention.
    if (!score && entry.match !== 'exact' && entry.kind === 'terms' && /^[\p{Script=Han}]{3,12}$/u.test(word) && overlap >= Math.max(1, word.length - 3)) {
      fuzzy.push({entry, word, overlap, tie});
    }
  }
  fuzzy.sort((a, b) => b.overlap - a.overlap || a.tie.localeCompare(b.tie));
  for (const candidate of fuzzy.slice(0, 128)) {
    const {entry, word, tie} = candidate, starts = new Set();
    for (let offset = 0; offset < word.length - 1; offset++) {
      for (const position of positions.get(word.slice(offset, offset + 2)) || []) {
        for (const shift of [-1, 0, 1]) if (position - offset + shift >= 0) starts.add(position - offset + shift);
      }
    }
    let found = false;
    for (const i of [...starts].slice(0, 64)) {
        for (const size of [word.length, word.length - 1, word.length + 1]) {
          const span = context.slice(i, i + size);
          if (/^[\p{Script=Han}]+$/u.test(span) && oneEdit(word, span)) { found = true; break; }
        }
        if (found) break;
    }
    if (found) ranked.push({ entry, score: 20 + word.length, tie });
  }
  const related = new Set();
  if (includeRelated) for (const word of exactWords) for (const id of pack.related?.get(word) || []) related.add(id);
  const retrieved = new Set(ranked.map(candidate => candidate.entry));
  for (const id of related) {
    const entry = pack.entries[id];
    if (entry.match !== 'exact' && !retrieved.has(entry)) ranked.push({entry, score: 5 + Math.min(Math.log2(entry.frequency + 1), 16) / 100, related: true, tie: createHash('sha256').update(entry.text).digest('hex')});
  }
  ranked.sort((a, b) => b.score - a.score || a.tie.localeCompare(b.tie));
  const result = []; let used = 0, names = 0, relatedCount = 0;
  for (const {entry, related: isRelated} of ranked) {
    const size = [...entry.text].length + 1;
    if (used + size > budget || (entry.kind === 'names' && names >= 8) || (isRelated && relatedCount >= 12)) continue;
    result.push(entry); used += size; names += Number(entry.kind === 'names'); relatedCount += Number(Boolean(isRelated));
    if (result.length >= limit) break;
  }
  return result;
}

export async function builtinVocabularyContext(text) {
  const pack = await loadBuiltinVocabulary();
  const selected = selectBuiltinVocabulary(pack, text, { limit: 48, budget: 1000 });
  return selected.length ? { version: pack.version, terms: selected.map(entry => entry.text) } : undefined;
}

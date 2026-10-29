export function phoneticCandidates(segments, entries, lexicon) {
  const data = lexicon || { readings: {}, version: null };
  let reviewedSegments = 0, limited = false;
  const byFirst = new Map(), canonical = new Set(entries.map(entry => entry.text));
  for (const entry of entries) {
    const chars = Array.from(entry.text);
    if (chars.length < 2 || chars.length > 12 || chars.some(char => !data.readings[char])) continue;
    const sounds = chars.map(char => data.readings[char]);
    for (const sound of sounds[0]) {
      const matches = byFirst.get(sound) || [];
      matches.push({ entry, chars, sounds }); byFirst.set(sound, matches);
    }
  }
  const candidates = [], seen = new Set(); let remaining = 16000;
  for (const segment of [...segments].reverse()) {
    if (segment.edited && segment.correction?.revision !== segment.revision) continue;
    if (segment.languageDetection && segment.languageDetection.language !== 'zh') continue;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(segment.text)) continue;
    if (segment.text.length > remaining) { limited = true; continue; }
    remaining -= segment.text.length;
    const chars = Array.from(segment.text), positions = []; let offset = 0;
    for (const char of chars) { positions.push(offset); offset += char.length; }
    for (let i = 0; i < chars.length && candidates.length < 50; i++) {
      const matches = new Set((data.readings[chars[i]] || []).flatMap(sound => byFirst.get(sound) || []));
      for (const { entry, chars: target, sounds } of matches) {
        if (i + target.length > chars.length) continue;
        const original = chars.slice(i, i + target.length).join('');
        if (canonical.has(original) || !sounds.every((choices, j) => (data.readings[chars[i + j]] || []).some(sound => choices.includes(sound)))) continue;
        const start = positions[i], key = `${segment.id}:${start}:${entry.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ segmentId: segment.id, revision: segment.revision, start, original, replacement: entry.text, kind: entry.kind, method: 'phonetic', source: entry.source || 'private', reason: '普通话读音相同，请结合原音与上下文核对', readingVersion: data.version });
        if (candidates.length >= 50) break;
      }
    }
    if (candidates.length >= 50) { limited = true; break; }
    reviewedSegments++;
  }
  return { candidates, reviewedSegments, limited };
}

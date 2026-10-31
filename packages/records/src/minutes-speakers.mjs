export function speakerLabels(snapshot, registry = [], current = []) {
  const labels = new Map(),
    used = new Set();
  const numbered = label => Number(label.match(/^(?:说话人|发言人|speaker)\s*(\d+)$/i)?.[1]) || 0;
  const assign = (identity, label = '', preferred = 0) => {
    const existing = labels.get(identity);
    if (existing) return existing;
    let number = preferred || numbered(label);
    if (!number || used.has(number)) {
      number = 1;
      while (used.has(number)) number++;
    }
    used.add(number);
    const display = `说话人${number}`;
    labels.set(identity, display);
    return display;
  };
  registry.forEach((speaker, index) => {
    const display = assign(speaker.id, speaker.label, numbered(speaker.label) || index + 1);
    if (speaker.hash) labels.set(speaker.hash, display);
    labels.set(`label:${speaker.label}`, display);
  });
  const identity = segment => {
    const label = segment.speaker?.trim() || '';
    return segment.speakerId || segment.speakerHash || (label && !/^(?:(?:说话人|发言人|speaker)\s*)?(?:未标注|未识别|未知|未区分|unknown|unlabeled)(?:说话人)?$/i.test(label) ? `label:${label}` : '');
  };
  for (const segment of [...current, ...snapshot].sort((a, b) => (a.startMs || 0) - (b.startMs || 0))) {
    const id = identity(segment);
    if (!id) continue;
    const display = labels.get(id) || labels.get(`label:${segment.speaker?.trim()}`) || assign(id, segment.speaker || '');
    labels.set(id, display);
    if (segment.speakerHash) labels.set(segment.speakerHash, display);
  }
  const exact = new Map(current.map(segment => [`${segment.id}:${segment.revision}`, segment]));
  return new Map([...current, ...snapshot].map(segment => {
    const key = `${segment.id}:${segment.revision}`,
      id = identity(segment) || identity(exact.get(key) || segment);
    return [key, labels.get(id) || '未区分说话人'];
  }));
}

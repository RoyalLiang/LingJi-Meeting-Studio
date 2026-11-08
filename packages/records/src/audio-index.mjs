const indexes = new WeakMap();
const sourceKey = source => `${source.id}:${source.epoch}`;
const chunkKey = chunk => `${chunk.sourceId}:${chunk.epoch}:${chunk.sequence}`;

// The transaction store supplies the same interface with indexed point reads.
export function audioChunkIndex(record) {
  const cached = indexes.get(record);
  if (cached?.chunks === record.chunks && cached.count === record.chunks.length) return cached;
  const bySequence = new Map(), sources = new Map();
  const index = {
    chunks: record.chunks, count: record.chunks.length,
    get(source, sequence) { return bySequence.get(`${sourceKey(source)}:${sequence}`); },
    ranges(source) { return sources.get(sourceKey(source)) || []; },
    append(chunk) {
      bySequence.set(chunkKey(chunk), chunk);
      const key = `${chunk.sourceId}:${chunk.epoch}`, ranges = sources.get(key) || [];
      let low = 0, high = ranges.length;
      while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid][0] < chunk.sequence) low = mid + 1; else high = mid; }
      const left = ranges[low - 1], right = ranges[low];
      if (left?.[1] === chunk.sequence - 1) { left[1] = chunk.sequence; if (right?.[0] === chunk.sequence + 1) { left[1] = right[1]; ranges.splice(low, 1); } }
      else if (right?.[0] === chunk.sequence + 1) right[0] = chunk.sequence;
      else ranges.splice(low, 0, [chunk.sequence, chunk.sequence]);
      sources.set(key, ranges); index.count = record.chunks.length;
    },
  };
  for (const chunk of record.chunks) if (Number.isSafeInteger(chunk.sequence) && chunk.sequence >= 0) index.append(chunk);
  indexes.set(record, index); return index;
}

const encoder = new TextEncoder();
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function truncateText(text, limit) {
  if (text.length <= limit) return text;
  const result = []; let bytes = 0;
  for (const part of segmenter ? segmenter.segment(text) : text) {
    if (result.length === limit) break;
    const value = typeof part === 'string' ? part : part.segment;
    bytes += encoder.encode(value).length;
    if (bytes > limit * 32) break;
    result.push(value);
  }
  return result.join('');
}

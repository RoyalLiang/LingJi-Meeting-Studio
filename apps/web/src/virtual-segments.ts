export function segmentRange(start: number, end: number, count: number, pinned = -1) {
  const first = Math.min(Math.max(0, count - 30), Math.max(0, start - 12)), last = Math.min(count - 1, Math.max(first + 29, end + 12), first + 48);
  const indexes = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
  if (pinned >= 0 && pinned < count && !indexes.includes(pinned)) indexes.push(pinned);
  return indexes.sort((a, b) => a - b);
}

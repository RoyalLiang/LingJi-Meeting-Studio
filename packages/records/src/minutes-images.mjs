export const otherMeetingImages = '其他会议画面';

// Use cited transcript revisions only. Overlapping or equally close topics leave the frame unassigned.
export function placeMeetingImages(minutes, groups, frames) {
  const placed = groups.map(() => []), other = [];
  if (!frames.length) return {placed, other};
  const segments = new Map((minutes.evidenceSnapshot || []).map(segment => [
    JSON.stringify([segment.id, segment.revision]), segment,
  ]));
  const ranges = groups.map(group => [...(group.evidence || []), ...group.items.flatMap(item => item.evidence || [])]
    .map(ref => segments.get(JSON.stringify([ref.segmentId, ref.revision])))
    .filter(segment => Number.isFinite(segment?.startMs))
    .map(({startMs, endMs}) => [startMs, Number.isFinite(endMs) && endMs >= startMs ? endMs : startMs]));
  for (const frame of frames.slice().sort((a, b) => a.atMs - b.atMs || a.revision - b.revision)) {
    let closest = Infinity, match = -1;
    for (const [index, range] of ranges.entries()) {
      const distance = range.reduce((min, [start, end]) => Math.min(min, Math.max(start - frame.atMs, frame.atMs - end, 0)), Infinity);
      if (distance < closest) {
        closest = distance;
        match = index;
      } else if (distance === closest) {
        match = -1;
      }
    }
    (match >= 0 && closest <= 12000 ? placed[match] : other).push(frame);
  }
  return {placed, other};
}

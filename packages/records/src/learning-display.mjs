/** Conservative presentation only. Raw speech remains the training/evidence source. */
export function cleanSpeechDisplay(text) {
  return String(text || "")
    .replace(
      /(为什么|为啥|怎么|这个|那个|这些|那些|我们|你们|他们|她们|就是|然后)(?:\s*\1)+/gu,
      "$1",
    )
    .replace(/([我你他她它您咱全])\1+/gu, "$1");
}

/** A single audio focus holds multiple questions; never merge different evidence. */
export function groupReviewCases(cases) {
  const groups = new Map();
  for (const row of cases) {
    const focus = row.source.focus;
    const key = JSON.stringify([
      row.source.recordId,
      row.source.transcriptRevision,
      focus.segmentId,
      focus.revision,
    ]);
    let group = groups.get(key);
    if (!group) {
      const original = row.display.original;
      group = {
        id: key,
        recordId: row.source.recordId,
        title:
          row.display.meetingTitle || "会议 " + row.source.recordId.slice(-8),
        original,
        text: cleanSpeechDisplay(original),
        startMs: row.display.startMs,
        endMs: row.display.endMs,
        rows: [],
      };
      groups.set(key, group);
    }
    if (!group.rows.some((existing) => existing.sample_id === row.sample_id))
      group.rows.push(row);
  }
  const recordOrder = new Map();
  for (const group of groups.values())
    if (!recordOrder.has(group.recordId))
      recordOrder.set(group.recordId, recordOrder.size);
  return [...groups.values()].sort(
    (a, b) =>
      recordOrder.get(a.recordId) - recordOrder.get(b.recordId) ||
      (a.startMs ?? Infinity) - (b.startMs ?? Infinity),
  );
}

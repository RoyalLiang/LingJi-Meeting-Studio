/**
 * Domain Service: Transcript Draft & Progression
 */

export function normalizeDraftText(value) {
  return String(value ?? "").trim();
}

/**
 * Calculates smooth progressive partial draft emissions between previous and next draft text.
 */
export function progressiveDraftEvents(previousText, nextText, status) {
  const normalizedNext = normalizeDraftText(nextText);
  if (!normalizedNext) {
    return [];
  }

  const normalizedPrevious = normalizeDraftText(previousText);
  const alignedPrevious = normalizedNext.startsWith(normalizedPrevious) ? normalizedPrevious : "";

  if (status === "final" && alignedPrevious === normalizedNext) {
    return [{
      text: normalizedNext,
      status: "final"
    }];
  }

  const startIndex = alignedPrevious.length;
  const deltaLength = normalizedNext.length - startIndex;
  if (deltaLength <= 0) {
    return [];
  }

  const step = Math.max(1, Math.ceil(deltaLength / 4));
  const events = [];

  for (let cursor = startIndex + step; cursor < normalizedNext.length; cursor += step) {
    events.push({
      text: normalizedNext.slice(0, cursor),
      status: "partial"
    });
  }

  events.push({
    text: normalizedNext,
    status: status === "final" ? "final" : "partial"
  });

  return events;
}

/**
 * Computes timing window for a segment given word count and current offset.
 */
export function calculateSegmentTiming(currentOffsetMs, wordCount) {
  const startMs = Number(currentOffsetMs ?? 0);
  const durationMs = Math.max(900, wordCount * 260);
  const endMs = startMs + durationMs;
  const nextOffsetMs = endMs + 280;

  return {
    startMs,
    endMs,
    durationMs,
    nextOffsetMs
  };
}

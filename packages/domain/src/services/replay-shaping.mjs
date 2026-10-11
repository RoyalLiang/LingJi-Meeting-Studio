/**
 * Domain Service: Replay Shaping & Aggregation
 */

export function shapeReplayPayload(session, segments = [], translations = [], audioClips = [], summary = null) {
  const sortedSegments = [...segments].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const sortedAudioClips = [...audioClips].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  return {
    session,
    segments: sortedSegments,
    translations: [...translations],
    audioClips: sortedAudioClips,
    summary
  };
}

export function attachSessionMetrics(session, replay) {
  return {
    ...session,
    segmentCount: replay?.segments?.length ?? 0,
    translationCount: replay?.translations?.length ?? 0
  };
}

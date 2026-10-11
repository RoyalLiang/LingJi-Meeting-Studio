/**
 * Domain Events & Envelopes
 */

export function createRealtimeEnvelope(type, sessionId, payload) {
  return {
    type,
    sessionId,
    emittedAt: new Date().toISOString(),
    payload
  };
}

export function createSessionStatusChangedEvent(sessionId, status) {
  return createRealtimeEnvelope("session.status_changed", sessionId, {
    id: sessionId,
    status
  });
}

export function createAudioChunkReceivedEvent(sessionId, metadata) {
  return createRealtimeEnvelope("audio.chunk_received", sessionId, metadata);
}

export function createAudioClipReceivedEvent(sessionId, audioClip) {
  return createRealtimeEnvelope("audio.clip_received", sessionId, audioClip);
}

export function createSegmentUpsertedEvent(sessionId, segment) {
  return createRealtimeEnvelope("segment.upserted", sessionId, segment);
}

export function createTranslationUpsertedEvent(sessionId, translation) {
  return createRealtimeEnvelope("translation.upserted", sessionId, translation);
}

export function createSummaryReadyEvent(sessionId, summary) {
  return createRealtimeEnvelope("summary.ready", sessionId, summary);
}

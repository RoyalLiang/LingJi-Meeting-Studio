const transientErrors = new Set([
  'doubao_connection_failed', 'doubao_stream_failed', 'doubao_incomplete_session',
  'doubao_completion_timeout', 'doubao_http_408', 'doubao_http_429',
  'doubao_http_500', 'doubao_http_502', 'doubao_http_503', 'doubao_http_504',
]);

export function retryableSpeechError(code) { return transientErrors.has(code); }

export function canRecoverSpeechSource(record, source, now = Date.now()) {
  return !record.deleted && !record.audioPurged && !record.audioCleanup && Date.parse(record.deleteAt) > now && source.asr?.state === 'failed'
    && retryableSpeechError(source.asr.error) && (source.asr.retryAt || 0) <= now;
}

export function canStartSpeechSource(record, source, now = Date.now()) {
  if (record.deleted || record.audioPurged || record.audioCleanup || Date.parse(record.deleteAt) <= now || source.watermark < 0
    || (source.asr?.lease || 0) > now || (source.asr?.retryAt || 0) > now) return false;
  const chunks = record.chunks.filter(chunk => chunk.sourceId === source.id);
  const recovering = canRecoverSpeechSource(record, source, now);
  return !chunks.some(chunk => chunk.expired || (!recovering && chunk.state !== 'done' && chunk.attempts >= 5)
    || (chunk.state === 'processing' && (chunk.lease || 0) > now))
    && chunks.some(chunk => chunk.state !== 'done' && (recovering || chunk.attempts < 5));
}

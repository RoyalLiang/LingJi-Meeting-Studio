export function setTranslationTarget(record, target, requireThat) {
  requireThat(['', 'zh', 'en', 'ja', 'es', 'fr', 'de'].includes(target), 'invalid_translation_target', 400);
  record.translationTarget = target;
  record.translationLiveFromMs = Math.max(0,...record.segments.map(segment=>segment.endMs));
  for(const source of record.sources)if(source.asr)delete source.asr.translation;
  record.translationRevision = (record.translationRevision || 0) + 1;
  for (const segment of record.segments) {
    for (const key of ['translationLease', 'translationFence', 'translationAttempts', 'translationRetryAt', 'translationError']) delete segment[key];
  }
}

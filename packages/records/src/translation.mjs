export function setTranslationTarget(record, target, requireThat) {
  requireThat(['', 'zh', 'en', 'ja', 'es', 'fr', 'de'].includes(target), 'invalid_translation_target', 400);
  record.translationTarget = target;
  record.translationRevision = (record.translationRevision || 0) + 1;
  for (const segment of record.segments) {
    for (const key of ['translationLease', 'translationFence', 'translationAttempts', 'translationRetryAt', 'translationError']) delete segment[key];
  }
}

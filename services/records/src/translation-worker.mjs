import { randomUUID } from 'node:crypto';
import { emit, requireThat } from '../../../packages/records/src/record.mjs';

const recent = (record, segment) => record.capture !== 'completed' && segment.endMs >= (record.translationLiveFromMs ?? Math.max(0,...record.segments.map(value=>value.endMs)));
const sameSettings = (record, claim) => !record.deleted && record.generation === claim.generation
  && record.translationTarget === claim.target && (record.translationRevision || 0) === claim.settingsRevision;

// Live work has its own lane, so historical requests cannot hold up a new utterance.
export async function processTranslation(repo, id, translate, mode = 'all') {
  let claim, reused=false;
  await repo.change(id, record => {
    if (record.deleted || !record.translationTarget || Date.parse(record.deleteAt) <= Date.now()) return;
    const now = Date.now();
    const eligible = record.segments.filter(segment => segment.translationLanguage !== record.translationTarget
      && (segment.translationAttempts || 0) < 3 && (segment.translationLease || 0) <= now && (segment.translationRetryAt || 0) <= now
      && (mode !== 'live' || recent(record,segment)));
    if (mode === 'live') eligible.sort((a,b) => b.startMs-a.startMs);
    const segment = eligible[0];
    const settings = { target:record.translationTarget, generation:record.generation, settingsRevision:record.translationRevision || 0, fence:randomUUID() };
    if (segment) {
      const cached=record.sources.find(source=>source.id===segment.sourceId)?.asr?.translation;
      if(cached?.target===record.translationTarget && cached.sourceText===segment.text && cached.startMs===segment.startMs && cached.text){
        segment.translation=cached.text;segment.translationLanguage=record.translationTarget;
        for(const key of ['translationLease','translationFence','translationError','translationAttempts','translationRetryAt'])delete segment[key];
        emit(record,'transcript.translated',{segmentId:segment.id});reused=true;return;
      }
      segment.translationLease = now + 150000; segment.translationFence = settings.fence;
      claim = { ...settings, kind:'segment', id:segment.id, revision:segment.revision, text:segment.text };
      return;
    }
    if (mode === 'history') return;
    const source = record.sources.find(source => {
      const preview = source.asr?.preview, value = source.asr?.translation;
      if (source.asr?.state !== 'running' || !preview?.text?.trim() || preview.text.trim().length < 4) return false;
      if (value?.target === record.translationTarget && value.sourceText === preview.text && value.text) return false;
      if ((value?.lease || 0) > now || (value?.requestedAt || 0) + 2500 > now) return false;
      return value?.requestedText !== preview.text || (value.attempts || 0) < 3;
    });
    if (!source) return;
    const preview = source.asr.preview, previous = source.asr.translation || {};
    source.asr.translation = { ...previous, requestedText:preview.text, requestedAt:now, target:record.translationTarget,
      attempts:previous.requestedText === preview.text ? (previous.attempts || 0) : 0, lease:now+10000, fence:settings.fence };
    claim = { ...settings, kind:'preview', id:source.id, epoch:source.epoch, streamFence:source.asr.fence,
      text:preview.text, startMs:preview.startMs };
  });
  if (!claim) return reused;
  try {
    const text = await translate(claim.text,claim.target,claim.kind === 'preview' ? {timeoutMs:8000,partial:true} : {});
    requireThat(typeof text === 'string' && text.trim() && text.length <= 20000, 'invalid_translation', 502);
    await repo.change(id, record => {
      if (!sameSettings(record,claim)) return;
      if (claim.kind === 'segment') {
        const segment = record.segments.find(segment => segment.id === claim.id);
        if (!segment || segment.revision !== claim.revision || segment.translationFence !== claim.fence) return;
        segment.translation = text.trim(); segment.translationLanguage = claim.target;
        for (const key of ['translationLease','translationFence','translationError','translationAttempts','translationRetryAt']) delete segment[key];
        emit(record,'transcript.translated',{segmentId:segment.id});
      } else {
        const source = record.sources.find(source => source.id === claim.id), value = source?.asr?.translation;
        if (!value || value.fence !== claim.fence) return;
        delete value.lease; delete value.fence;
        // Appends may keep a provisional prefix; any correction or new utterance invalidates it.
        if (source.epoch !== claim.epoch || source.asr.fence !== claim.streamFence || source.asr.preview?.startMs !== claim.startMs
          || !source.asr.preview?.text.startsWith(claim.text)) return;
        Object.assign(value,{text:text.trim(),sourceText:claim.text,startMs:claim.startMs,updatedAt:Date.now()});
        delete value.error; delete value.errorText; value.attempts=0;
        emit(record,'transcript.preview_translated',{sourceId:source.id});
      }
    });
    return true;
  } catch (error) {
    await repo.change(id, record => {
      if (!sameSettings(record,claim)) return;
      if (claim.kind === 'segment') {
        const segment = record.segments.find(segment => segment.id === claim.id);
        if (!segment || segment.revision !== claim.revision || segment.translationFence !== claim.fence) return;
        segment.translationAttempts=(segment.translationAttempts || 0)+1; segment.translationError=error.code || 'translation_failed';
        segment.translationRetryAt=Date.now()+60000; delete segment.translationLease; delete segment.translationFence;
        emit(record,'transcript.translation_failed',{segmentId:segment.id});
      } else {
        const source=record.sources.find(source=>source.id===claim.id),value=source?.asr?.translation;
        if (!value || value.fence !== claim.fence) return;
        value.attempts=(value.attempts || 0)+1;value.error=error.code || 'translation_failed';value.errorText=claim.text;
        delete value.lease;delete value.fence;emit(record,'transcript.preview_translation_failed',{sourceId:source.id});
      }
    });
    return false;
  }
}

import { createHash, randomUUID } from 'node:crypto';

export const speakerHash = (recordId, identity) => createHash('sha256').update(`meeting-speaker:v1:${recordId}:${identity}`).digest('hex');
import { emit, finalize, requireThat } from './record.mjs';

// IDs are acoustic identities within one vendor connection, never audio chunk numbers.
export function commitSpeakerTurns(record, sourceId, fence, turns, generation) {
  requireThat(!record.deleted && record.generation === generation, 'stale_generation', 410);
  const source = record.sources.find(s=>s.id===sourceId);
  if (source?.asr?.fence !== fence) return false;
  record.speakers ||= [];
  for(const speaker of record.speakers) speaker.hash ||= speakerHash(record.id,speaker.id);
  source.asr.speakerMap ||= {};
  let changed=false;
  const audioEnd=Math.max(0,...record.chunks.filter(c=>c.sourceId===sourceId).map(c=>(c.sampleOffset+c.sampleCount)/16));
  for (const turn of turns) {
    if (!turn.text?.trim() || !Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs) || turn.startMs<0 || turn.endMs<=turn.startMs || turn.endMs>audioEnd+250) continue;
    const overlap=s=>Math.max(0,Math.min(s.endMs,turn.endMs)-Math.max(s.startMs,turn.startMs));
    const previous=record.segments.filter(s=>s.sourceId===sourceId && overlap(s)>=Math.min(s.endMs-s.startMs,turn.endMs-turn.startMs)*0.7);
    if(previous.length>1){source.asr.identityWarning='ambiguous_replay';continue;}
    const old=previous[0];
    const providerId=turn.speakerId != null && /^\d{1,3}$/.test(String(turn.speakerId)) ? String(turn.speakerId) : null;
    let identity=providerId===null ? null : source.asr.speakerMap[providerId];
    // Replaying the same audio interval anchors IDs after a reconnect. Text similarity is not identity evidence.
    const anchorIdentity=old?.speakerAnchorId || old?.speakerId;
    if (!identity && providerId!==null && anchorIdentity && !Object.values(source.asr.speakerMap).includes(anchorIdentity)) identity=anchorIdentity;
    if (!identity && providerId!==null && source.asr.mayAllocate && record.speakers.length<10) {
      identity=speakerHash(record.id,randomUUID()); record.speakers.push({id:identity,hash:identity,label:`说话人 ${record.speakers.length+1}`});
    }
    if (identity && providerId!==null) source.asr.speakerMap[providerId]=identity;
    const registered=record.speakers.find(s=>s.id===identity);
    const speaker=registered?.label || old?.speaker || '';
    const identityHash=registered?.hash || old?.speakerHash || null;
    identity ||= old?.speakerId || null;
    if (old?.edited) { if(old.speakerId) old.speakerHash ||= record.speakers.find(s=>s.id===old.speakerId)?.hash;continue; }
    const chunk=record.chunks.find(c=>c.sourceId===sourceId && c.sampleOffset/16<=turn.startMs && (c.sampleOffset+c.sampleCount)/16>turn.startMs);
    if (old) {
      if (old.text===turn.text.trim() && old.speaker===speaker && old.speakerHash===identityHash && old.startMs===turn.startMs && old.endMs===turn.endMs) continue;
      Object.assign(old,{text:turn.text.trim(),speaker,speakerId:identity,speakerHash:identityHash,startMs:turn.startMs,endMs:turn.endMs,revision:old.revision+1,translation:null});
      for(const field of ['translationLanguage','translationLease','translationAttempts','translationRetryAt','translationError'])delete old[field];
    } else record.segments.push({id:randomUUID(),revision:1,sourceId,chunkKey:chunk?.key,startMs:turn.startMs,endMs:turn.endMs,text:turn.text.trim(),speaker,speakerId:identity,speakerHash:identityHash,translation:null,edited:false});
    changed=true;
  }
  if (changed) { record.transcription='processing'; record.transcriptRevision++; emit(record,'transcript.committed',{sourceId,transcriptRevision:record.transcriptRevision}); }
  return changed;
}

export function finishSpeakerSource(record, sourceId, fence, generation) {
  requireThat(!record.deleted && record.generation===generation,'stale_generation',410);
  const source=record.sources.find(s=>s.id===sourceId);
  if (source?.asr?.fence!==fence || !source.asr.ended || source.watermark!==source.lastSequence) return false;
  for (const chunk of record.chunks.filter(c=>c.sourceId===sourceId)) { chunk.state='done'; delete chunk.lease; delete chunk.error; }
  source.asr.state='completed';source.asr.preview=null; delete source.asr.lease;
  record.transcription='processing'; emit(record,'transcription.source_completed',{sourceId}); finalize(record); return true;
}

export function updateTranscriptPreview(record,sourceId,fence,preview,runtime,generation){
  if(record.deleted || record.generation!==generation)return false;
  const source=record.sources.find(s=>s.id===sourceId);
  if(source?.asr?.fence!==fence || source.asr.state!=='running')return false;
  const text=typeof preview?.text==='string' ? preview.text.slice(0,8000) : '';
  const firstAccepted=Math.min(...record.chunks.filter(c=>c.sourceId===sourceId).map(c=>c.acceptedAt));
  const firstUiReadyMs=source.asr.runtime?.firstUiReadyMs ?? (text && Number.isFinite(firstAccepted) ? Date.now()-firstAccepted : undefined);
  const nextRuntime={...runtime,...(firstUiReadyMs!=null ? {firstUiReadyMs} : {})};
  if((source.asr.preview?.text||'')===text && JSON.stringify(source.asr.runtime)===JSON.stringify(nextRuntime))return false;
  source.asr.preview=text ? {text,startMs:preview.startMs||0,updatedAt:Date.now()} : null;
  source.asr.runtime=nextRuntime;
  emit(record,'transcript.preview',{sourceId});return true;
}

import { randomUUID } from 'node:crypto';
import { commitTranscriptBatch, emit, requireThat } from '../../../packages/records/src/record.mjs';
import { readConfig } from './config.mjs';
import { transcribeFunasr } from './funasr.mjs';
import { LOCAL_ASR_MODEL } from './local-asr.mjs';

const RATE = 16000, MAX_SAMPLES = RATE * 30, MAX_CHUNKS = 128;
const enabled = config => ['funasr', 'sensevoice-local'].includes(config.ASR_PROVIDER) && config.MINUTES_MODE !== 'doubao-audio-only';
const sameService = (a,b) => enabled(b) && a.ASR_PROVIDER === b.ASR_PROVIDER && (a.ASR_PROVIDER === 'sensevoice-local' ? a.LINGJI_LOCAL_ASR_DIR === b.LINGJI_LOCAL_ASR_DIR : ['FUNASR_API_URL','FUNASR_MODEL','FUNASR_API_KEY'].every(key => (a[key] || '') === (b[key] || '')));

// Choose only durable packet boundaries. FunASR performs model VAD inside each
// resulting utterance; this quiet-tail heuristic is not a streaming model.
function batchEnd(parts, chunks, stopped, oldestAt, now) {
  let samples = 0, quiet = 0;
  for (let i = 0; i < parts.length; i++) {
    const bytes = parts[i];
    for (let at = 0; at < bytes.length; at += 640) {
      const end = Math.min(at + 640, bytes.length); let squares = 0;
      for (let p = at; p < end; p += 2) squares += (bytes.readInt16LE(p) / 32768) ** 2;
      const count = (end - at) / 2;
      quiet = Math.sqrt(squares / count) < 0.001 ? quiet + count : 0;
    }
    samples += chunks[i].sampleCount;
    if (samples >= RATE * 2 && quiet >= RATE * 0.6) return i + 1;
  }
  if (stopped || samples >= MAX_SAMPLES || chunks.length >= MAX_CHUNKS || now - oldestAt >= 20000) return chunks.length;
  return 0;
}

export async function processFunasrAudio(repo, candidate, config, transcriber = transcribeFunasr) {
  async function work() {
    let claim;
    await repo.change(candidate.id, r => {
      if (r.deleted || Date.parse(r.deleteAt) <= Date.now()) return;
      const now = Date.now();
      for (const source of r.sources) {
        if (source.asr?.state === 'failed' && source.asr.provider !== config.ASR_PROVIDER && source.asr.attempts !== 0) continue;
        const pending = r.chunks.filter(c => c.sourceId === source.id && c.epoch === source.epoch && c.state !== 'done').sort((a,b) => a.sequence-b.sequence);
        const first = pending[0];
        if (!first || first.expired || first.attempts >= 5 || (first.lease || 0) > now || first.sequence > source.watermark
          || ((first.retryAt || 0) > now && !(source.stopped && first.batchWaiting))) continue;
        const chunks = []; let samples = 0;
        for (const chunk of pending) {
          const previous = chunks.at(-1);
          if (chunk.sequence > source.watermark || chunk.expired || chunk.attempts >= 5 || (chunk.lease || 0) > now
            || ((chunk.retryAt || 0) > now && !chunk.batchWaiting)
            || (previous && (chunk.sequence !== previous.sequence+1 || chunk.sampleOffset !== previous.sampleOffset+previous.sampleCount))
            || samples + chunk.sampleCount > MAX_SAMPLES) break;
          chunks.push(chunk); samples += chunk.sampleCount;
          if (chunks.length >= MAX_CHUNKS || samples >= MAX_SAMPLES) break;
        }
        if (!chunks.length) continue;
        const boundary = r.chunks.some(c => c.sourceId === source.id && c.sequence === chunks.at(-1).sequence+1 && c.state === 'done');
        if (source.stopped && source.watermark < source.lastSequence && samples < MAX_SAMPLES && !boundary) continue;
        const stopped = source.stopped || boundary || samples + (pending[chunks.length]?.sampleCount || 0) > MAX_SAMPLES;
        if (samples < RATE * 2 && !stopped && now - first.acceptedAt < 20000) continue;
        const fence = randomUUID();
        for (const chunk of chunks) { chunk.fence = fence; chunk.lease = now + 180000; chunk.state = 'processing'; }
        claim = { generation:r.generation, sourceId:source.id, epoch:source.epoch, language:r.language, chunks:structuredClone(chunks), fence, stopped, oldestAt:first.acceptedAt };
        break;
      }
    });
    if (!claim) return;
    const owns = r => !r.deleted && r.generation === claim.generation && Date.parse(r.deleteAt) > Date.now()
      && claim.chunks.every(c => r.chunks.some(current => current.key === c.key && current.fence === claim.fence && current.state === 'processing'));
    const release = (r, wait = false) => {
      for (const chunk of r.chunks.filter(c => c.fence === claim.fence && c.state === 'processing')) {
        chunk.state = 'pending'; delete chunk.lease; delete chunk.fence;
        if (wait) { chunk.retryAt = Date.now() + 2000; chunk.batchWaiting = true; }
        else if (chunk.batchWaiting) { delete chunk.retryAt; delete chunk.batchWaiting; }
      }
    };
    try {
      const parts = [];
      for (let at = 0; at < claim.chunks.length; at += 4) parts.push(...await Promise.all(claim.chunks.slice(at,at+4).map(async c => {
        const bytes = await repo.readAudio(c.object);
        requireThat(bytes.length === c.sampleCount * 2, 'invalid_funasr_audio', 422); return bytes;
      })));
      const latest = await repo.get(candidate.id);
      if (!owns(latest)) return;
      const latestSource = latest.sources.find(s=>s.id===claim.sourceId && s.epoch===claim.epoch);
      const extra = latest.chunks.find(c=>c.sourceId===claim.sourceId && c.sequence===claim.chunks.at(-1).sequence+1 && c.state!=='done' && !c.expired && c.attempts<5 && (c.lease||0)<=Date.now() && (c.retryAt||0)<=Date.now());
      const tailGrew = latestSource.stopped && extra && claim.chunks.length<MAX_CHUNKS && claim.chunks.reduce((sum,c)=>sum+c.sampleCount,0)+extra.sampleCount<=MAX_SAMPLES;
      if (tailGrew) { await repo.change(candidate.id,r=>{if(owns(r))release(r);}); return; }
      const draining = latestSource.stopped && latestSource.watermark === latestSource.lastSequence;
      const end = batchEnd(parts, claim.chunks, claim.stopped || draining, claim.oldestAt, Date.now());
      if (!end) { await repo.change(candidate.id, r => { if (owns(r)) release(r,!latestSource.stopped); }); return; }
      const selected = claim.chunks.slice(0,end);
      if (end < claim.chunks.length) {
        let released = false;
        await repo.change(candidate.id,r=>{
          if (!owns(r)) return;
          const suffix = new Set(claim.chunks.slice(end).map(c=>c.key));
          for (const chunk of r.chunks.filter(c=>suffix.has(c.key))) {
            chunk.state='pending'; delete chunk.lease; delete chunk.fence;
            if (chunk.batchWaiting) { delete chunk.batchWaiting; delete chunk.retryAt; }
          }
          released = true;
        });
        if (!released) return;
        claim.chunks = selected;
      }
      const currentConfig = await readConfig(repo.root);
      if (!sameService(config,currentConfig)) { await repo.change(candidate.id,r=>{if(owns(r))release(r);}); return; }
      // Recheck the durable claim immediately before sending audio to the service.
      const current = await repo.get(candidate.id);
      if (!owns(current)) return;
      const text = await transcriber(Buffer.concat(parts.slice(0,end)), {language:claim.language}, config);
      const afterConfig = await readConfig(repo.root);
      await repo.change(candidate.id, r => {
        if (!owns(r)) return;
        if (!sameService(config,afterConfig)) { release(r); return; }
        commitTranscriptBatch(r, selected.map(c=>c.key), text, claim.generation, config.ASR_PROVIDER === 'sensevoice-local' ? LOCAL_ASR_MODEL : config.FUNASR_MODEL, {provider:config.ASR_PROVIDER});
        release(r);
        const source = r.sources.find(s=>s.id===claim.sourceId && s.epoch===claim.epoch);
        source.asr = {provider:config.ASR_PROVIDER,state:source.stopped && r.chunks.filter(c=>c.sourceId===source.id).every(c=>c.state==='done') ? 'completed' : 'queued'};
      });
    } catch (error) {
      const afterConfig = await readConfig(repo.root).catch(() => config);
      await repo.change(candidate.id, r => {
        if (!owns(r)) return;
        if (error.code === 'local_asr_shutdown' || !sameService(config,afterConfig)) { release(r); return; }
        for (const chunk of r.chunks.filter(c=>c.fence===claim.fence)) {
          chunk.state='pending'; delete chunk.lease; delete chunk.batchWaiting; delete chunk.fence;
          chunk.attempts++; chunk.error=error.code || 'funasr_service_unavailable'; chunk.retryAt=Date.now()+Math.min(60000,2000*2**chunk.attempts);
        }
        const source=r.sources.find(s=>s.id===claim.sourceId && s.epoch===claim.epoch);
        source.asr={provider:config.ASR_PROVIDER,state:'failed',error:error.code || 'funasr_service_unavailable'};
        r.transcription=r.chunks.some(c=>c.attempts>=5 && c.state!=='done')?'failed':'blocked';
        emit(r,'transcription.blocked',{error:source.asr.error});
      });
    }
  }
  await Promise.all([work(),work()]);
}

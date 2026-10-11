import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { commitMinutes, commitTranscript, emit } from '../../../packages/records/src/record.mjs';
import { createRepository } from './repository.mjs';
import { generateMinutes, transcribe, translateText } from './providers.mjs';

export async function runCycle(repo, providers = {}) {
  const records = await repo.listWork();
  async function processCandidate(candidate) {
    if (candidate.deleted && candidate.cleanup === 'completed' && Date.now() - (candidate.cleanupAt || 0) < 600000) return;
    if (candidate.deleted || Date.parse(candidate.deleteAt) < Date.now()) {
      await repo.change(candidate.id, r => {
        if (!r.deleted) { r.deleted = true; r.generation++; r.title = '已删除'; r.segments = []; r.notes = ''; r.minutes = null;
          r.jobs = []; r.shares = []; r.minutesHistory = []; emit(r, 'record.deleted'); }
        r.cleanup = 'pending';
      });
      await repo.cleanAudio(candidate.id); await repo.change(candidate.id, r => { r.chunks = []; r.cleanup = 'completed'; r.cleanupAt = Date.now(); }); return;
    }
    const expired = candidate.chunks.filter(c => !c.expired && !candidate.retainAudio && Date.now() - (c.acceptedAt || Date.parse(candidate.createdAt)) > 86400000);
    if (expired.length) {
      await repo.change(candidate.id, r => { for (const c of r.chunks) if (expired.some(e => e.key === c.key)) { c.expired = true; if (c.state !== 'done') { c.attempts = 5; c.error = 'temporary_audio_expired'; r.transcription = 'failed'; delete c.lease; } } emit(r, 'audio.expired'); });
      await repo.cleanAudio(candidate.id, new Set(candidate.chunks.filter(c => !expired.some(e => e.key === c.key)).map(c => c.object)));
    }
    let claimed;
    if (candidate.chunks.some(c => c.state !== 'done' && c.attempts < 5 && (!c.retryAt || c.retryAt <= Date.now()) && (!c.lease || c.lease < Date.now()))) await repo.change(candidate.id, r => {
      if (r.deleted || Date.parse(r.deleteAt) <= Date.now()) return;
      const chunk = r.chunks.find(c => c.state !== 'done' && c.attempts < 5 && (!c.retryAt || c.retryAt <= Date.now())
        && (!c.lease || c.lease < Date.now()) && !r.chunks.some(p => p.sourceId === c.sourceId && p.sequence < c.sequence && p.state !== 'done')
        && r.sources.find(s => s.id === c.sourceId)?.watermark >= c.sequence);
      if (!chunk) return;
      chunk.lease = Date.now() + 240000; chunk.fence = randomUUID(); chunk.state = 'processing';
      claimed = { record: structuredClone(r), chunk: structuredClone(chunk) };
    });
    if (claimed) {
      const { record, chunk } = claimed;
      try {
        const text = await (providers.transcribe || transcribe)(await repo.readAudio(chunk.object), record, chunk);
        let translation = null;
        if (record.translationTarget && text) {
          try { translation = await (providers.translate || translateText)(text, record.translationTarget); }
          catch { translation = null; }
        }
        await repo.change(record.id, r => {
          if (r.chunks.find(c => c.key === chunk.key)?.fence !== chunk.fence) return;
          commitTranscript(r, chunk.key, text, record.generation, translation);
        });
      } catch (error) {
        await repo.change(record.id, r => {
          const current = r.chunks.find(c => c.key === chunk.key);
          if (!current || current.fence !== chunk.fence || r.deleted) return;
          current.state = 'pending'; current.attempts++; current.error = error.code || 'asr_request_failed';
          current.retryAt = Date.now() + Math.min(60000, 2000 * 2 ** current.attempts); delete current.lease;
          r.transcription = current.attempts >= 5 ? 'failed' : 'blocked'; emit(r, 'transcription.blocked', { error: current.error });
        });
      }
    }
    let jobClaim;
    if (candidate.jobs.some(j => j.status === 'queued' || (j.status === 'running' && j.lease < Date.now()))) await repo.change(candidate.id, r => {
      if (r.deleted) return;
      const job = r.jobs.find(j => (j.status === 'queued' || (j.status === 'running' && j.lease < Date.now())) && j.attempts < 3);
      if (!job) return;
      job.status = 'running'; job.attempts++; job.fence = randomUUID(); job.lease = Date.now() + 180000;
      jobClaim = structuredClone(job); emit(r, 'minutes.running', { jobId: job.id });
    });
    if (jobClaim) {
      try {
        const result = await (providers.minutes || generateMinutes)(jobClaim);
        await repo.change(candidate.id, r => commitMinutes(r, jobClaim.id, result, jobClaim.fence));
      } catch (error) {
        await repo.change(candidate.id, r => {
          const job = r.jobs.find(j => j.id === jobClaim.id);
          if (!job || job.fence !== jobClaim.fence || r.deleted) return;
          job.status = 'failed'; job.error = error.code || 'minutes_request_failed'; emit(r, 'minutes.failed', { jobId: job.id, error: job.error });
        });
      }
    }
    const latest = await repo.get(candidate.id);
    if (!latest.audioPurged && !latest.retainAudio && latest.capture === 'completed' && latest.chunks.every(c => c.state === 'done')) {
      let purge = false;
      await repo.change(latest.id, r => { if (r.capture === 'completed' && !r.retainAudio) { r.audioCleanup = true; purge = true; } });
      if (purge) { await repo.cleanAudio(latest.id); await repo.change(latest.id, r => { r.audioPurged = true; r.audioCleanup = false; }); }
    } else {
      // Objects written before a failed metadata transaction are removed after a one-hour grace period.
      if (Date.now() - (latest.gcAt || 0) > 3600000) {
        await repo.cleanAudio(latest.id, new Set(latest.chunks.filter(c => !c.expired).map(c => c.object)), Date.now() - 3600000);
        await repo.change(latest.id, r => { r.gcAt = Date.now(); });
      }
    }
  }
  let next = 0;
  const concurrency = Math.max(1, Math.min(8, Number(process.env.RECORD_WORKER_CONCURRENCY || 3)));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < records.length) await processCandidate(records[next++]);
  }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = await createRepository(); let stop = false;
  process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
  console.log(`[record-worker] ${repo.backend}; durable audio and minutes queue`);
  while (!stop) { try { await runCycle(repo); } catch (e) { console.error('[record-worker] cycle failed', e.code || e.name); } await new Promise(r => setTimeout(r, 1000)); }
  await repo.close();
}

import { processFunasrAudio } from './funasr-transcription.mjs';
import { processDoubaoModelAudio } from './doubao-model-transcription.mjs';
import { doubaoAudioEnabled } from './config.mjs';
import { chronologicalSegments, minutesContext, liveBaseline } from '../../../packages/records/src/live-minutes.mjs';
import { audioMinutesEnabled } from './config.mjs';
import { generateDoubaoAudioMinutes } from './doubao-audio-minutes.mjs';
import {runLearningCycle} from './learning-worker.mjs';
import { runMinutesPipeline } from './minutes-pipeline.mjs';
import { meteredMinutesCall } from './minutes-usage.mjs';
import { telemetry } from './telemetry.mjs';
import { processWorkspaceAnalysis } from './workspace-worker.mjs';
import { processSpeakerSources, closeSpeakerStreams } from './speaker-streams.mjs';
import { queueAutomaticMinutes, updateMinutesPreview } from '../../../packages/records/src/automation.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { commitMinutes, commitTranscript, emit, needsMinutesAudio } from '../../../packages/records/src/record.mjs';
import { createRepository } from './repository.mjs';
import { readConfig } from './config.mjs';
import { recordAsrConfig } from './vocabulary.mjs';
import { commitIntents, ruleIntents } from '../../../packages/records/src/intents.mjs';
import { providerStatus, analyzeIntents, generateMinutes, minutesTimeoutMs, transcribe, translateText } from './providers.mjs';

import { processRealtimeAudio, generateRealtimeMinutes, closeRealtime, reconcileRealtime, realtimeEnabled } from './realtime-minutes.mjs';
import { minutesModelVersion } from './config.mjs';

export async function runCycle(repo, providers = {}, { lane = 'all' } = {}) {
  const config = await readConfig(repo.root);
  const learningEnabled=config.RECORD_LEARNING_ENABLED==='true' || (config.RECORD_LEARNING_ENABLED!=='false' && process.env.NODE_ENV==='desktop');
  if(lane==='learning'){if(learningEnabled && (!providerStatus(config).fixture || providers.learningPreparation))await runLearningCycle(repo,providers);return;}
  if (lane === 'workspace') { await processWorkspaceAnalysis(repo, config, providers); return; }
  if (lane === 'realtime' || lane === 'all') await reconcileRealtime(repo, config);
  const records = await repo.listWork({ lane });
  async function processCandidate(candidate) {
    if (lane !== 'all' && lane !== 'audio' && lane !== 'realtime' && (candidate.deleted || Date.parse(candidate.deleteAt) < Date.now())) return;
    if (candidate.deleted && candidate.cleanup === 'completed' && Date.now() - (candidate.cleanupAt || 0) < 600000) return;
    if (candidate.deleted || Date.parse(candidate.deleteAt) < Date.now()) {
      closeSpeakerStreams(repo,candidate.id);closeRealtime(repo,candidate.id);
      await repo.change(candidate.id, r => {
        if (!r.deleted) { r.deleted = true; delete r.waveforms; r.generation++; r.title = '已删除'; r.segments = []; r.notes = ''; r.minutes = null; r.liveMinutes = null;
          r.jobs = []; r.shares = []; r.minutesHistory = []; r.insights = null; emit(r, 'record.deleted'); }
        r.cleanup = 'pending';
      });
      await repo.cleanAudio(candidate.id); await repo.change(candidate.id, r => { r.chunks = []; delete r.waveforms; r.cleanup = 'completed'; r.cleanupAt = Date.now(); }); return;
    }
    if (lane === 'realtime') { await processRealtimeAudio(repo, candidate, config, providers.realtimeFactory); return; }
    if (lane === 'all' || lane === 'audio') {
    const expired = candidate.chunks.filter(c => !c.expired && !candidate.retainAudio && Date.now() - (c.acceptedAt || Date.parse(candidate.createdAt)) > 86400000);
    if (expired.length) {
      await repo.change(candidate.id, r => { delete r.waveforms; for (const c of r.chunks) if (expired.some(e => e.key === c.key)) { c.expired = true; if (c.state !== 'done') { c.attempts = 5; c.error = 'temporary_audio_expired'; r.transcription = 'failed'; delete c.lease; } } emit(r, 'audio.expired'); });
      await repo.cleanAudio(candidate.id, new Set(candidate.chunks.filter(c => !expired.some(e => e.key === c.key)).map(c => c.object)));
    }
    const realtimeWork = lane === 'all' ? processRealtimeAudio(repo, candidate, config, providers.realtimeFactory) : Promise.resolve();
    const audioConfig = await recordAsrConfig(repo, candidate, config);
    const speakerMode=!providers.transcribe && providerStatus(config).asrProvider==='doubao' && providerStatus(config).asr && !providerStatus(config).fixture && ['auto','zh','en','zhen'].includes(candidate.language);
    const funasrMode=!providers.transcribe && ['funasr','sensevoice-local'].includes(config.ASR_PROVIDER) && config.MINUTES_MODE!=='doubao-audio-only' && !providerStatus(config).fixture;
    async function processAudio() {
      if (funasrMode || speakerMode || (config.MINUTES_MODE === 'doubao-audio-only' && !providerStatus(config).fixture)) return;
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
        const text = await telemetry.measure('asr.confirmed', {recordId:record.id, sourceId:chunk.sourceId, sequence:chunk.sequence, traceId:chunk.traceId, queueMs:Date.now()-chunk.acceptedAt}, async () => (providers.transcribe || transcribe)(await repo.readAudio(chunk.object), record, chunk, audioConfig));
        await repo.change(record.id, r => {
          if (r.chunks.find(c => c.key === chunk.key)?.fence !== chunk.fence) return;
          commitTranscript(r, chunk.key, text, record.generation);
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
    }
    if (funasrMode) { closeSpeakerStreams(repo,candidate.id); await processFunasrAudio(repo,candidate,config); }
    if (config.MINUTES_MODE === 'doubao-audio-only' && !providerStatus(config).fixture) { closeSpeakerStreams(repo,candidate.id); await processDoubaoModelAudio(repo,candidate,config); }
    if (speakerMode) await processSpeakerSources(repo,candidate,audioConfig);
    // Two independent sources can progress together; a source remains strictly ordered.
    await Promise.all([processAudio(), processAudio(), realtimeWork]);
    }
    if (lane === 'all' || lane === 'translation') {
      let claim;
      await repo.change(candidate.id, r => {
        if (r.deleted || !r.translationTarget || (!providers.translate && !providerStatus(config).translation)) return;
        const segment = r.segments.find(s => s.translationLanguage !== r.translationTarget && (s.translationAttempts || 0) < 3 && (s.translationLease || 0) <= Date.now() && (s.translationRetryAt || 0) <= Date.now());
        if (!segment) return;
        segment.translationLease = Date.now() + 150000; segment.translationFence = randomUUID();
        claim = { id: segment.id, revision: segment.revision, text: segment.text, target: r.translationTarget, generation: r.generation, settingsRevision: r.translationRevision || 0, fence: segment.translationFence };
      });
      if (claim) try {
        const text = await (providers.translate || translateText)(claim.text, claim.target, config);
        await repo.change(candidate.id, r => {
          const s = r.segments.find(s => s.id === claim.id);
          if (!s || r.deleted || r.generation !== claim.generation || s.revision !== claim.revision || r.translationTarget !== claim.target || (r.translationRevision || 0) !== claim.settingsRevision || s.translationFence !== claim.fence) return;
          s.translation = text; s.translationLanguage = claim.target; delete s.translationLease; delete s.translationFence; delete s.translationError; delete s.translationAttempts; delete s.translationRetryAt;
          emit(r, 'transcript.translated', {segmentId: s.id});
        });
      } catch (error) { await repo.change(candidate.id, r => {
        const s = r.segments.find(s => s.id === claim.id); if (!s || r.deleted || r.generation !== claim.generation || s.revision !== claim.revision || r.translationTarget !== claim.target || (r.translationRevision || 0) !== claim.settingsRevision || s.translationFence !== claim.fence) return;
        s.translationAttempts = (s.translationAttempts || 0) + 1; s.translationError = error.code || 'translation_failed'; s.translationRetryAt = Date.now() + 60000; delete s.translationLease; delete s.translationFence; emit(r, 'transcript.translation_failed', {segmentId:s.id});
      }); }
    }
    const updated = await repo.get(candidate.id);
    if ((lane === 'all' || lane === 'intents') && !updated.deleted && updated.segments.length && updated.insights?.transcriptRevision !== updated.transcriptRevision && (updated.intentRetryAt || 0) <= Date.now()) {
      let claim;
      await repo.change(candidate.id, r => {
        if (r.deleted || r.insights?.transcriptRevision === r.transcriptRevision || (r.intentLease || 0) > Date.now()) return;
        r.intentLease = Date.now() + 180000;
        const snapshot=chronologicalSegments(r.segments.slice(-120)).map(({id, revision, text, startMs, endMs, speakerId, speaker, sourceId}) => ({id, revision, text, startMs, endMs, speakerId, speaker, sourceId}));
        claim = { snapshot, context:minutesContext(liveBaseline(r),snapshot), revision: r.transcriptRevision, generation: r.generation };
      });
      if (claim) {
        try {
          const model = updated.analysisConsent === true && providerStatus(config).textMinutes && JSON.stringify({transcript:claim.snapshot,context:claim.context}).length <= 180000;
          const result = model ? await (providers.intents || analyzeIntents)(claim.snapshot, config, claim.context) : ruleIntents(claim.snapshot);
          await repo.change(candidate.id, r => { if (r.generation !== claim.generation) return; commitIntents(r, claim.snapshot, result, model ? 'model' : 'rules', claim.revision, claim.generation); delete r.intentLease; delete r.intentRetryAt; });
        } catch (error) {
          await repo.change(candidate.id, r => { if (r.generation !== claim.generation) return; r.intentError = error.code || 'intent_analysis_failed'; r.intentRetryAt = Date.now() + 60000; delete r.intentLease; emit(r, 'intents.blocked'); });
        }
      }
    }
    let jobClaim;
    if (lane === 'all' || lane === 'minutes') {
    if (providerStatus(config).minutes) await repo.change(candidate.id, r => { if (!audioMinutesEnabled(config) || r.realtimeAudioConsent) queueAutomaticMinutes(r, minutesModelVersion(config)); });
    const minutesCandidate = await repo.get(candidate.id);
    const now=Date.now(), reclaimable=job=>job.status==='queued'||(job.status==='running'&&(!Number.isFinite(job.lease)||job.lease<=now));
    if (minutesCandidate.jobs.some(reclaimable)) await repo.change(candidate.id, r => {
      if (r.deleted) return;
      for(const job of r.jobs)if(reclaimable(job)&&job.attempts>=3){
        job.status='failed';job.error='minutes_request_failed';job.failedAt=now;job.fence=null;job.snapshot=[];
        delete job.lease;delete job.preview;delete job.partialMinutes;emit(r,'minutes.failed',{jobId:job.id,error:job.error});
      }
      if(r.jobs.some(j=>j.status==='running' && j.lease>Date.now()))return;
      const job = r.jobs.filter(j => reclaimable(j) && j.attempts < 3).sort((a,b)=>(a.scope==='live')-(b.scope==='live'))[0];
      if (!job) return;
      job.status = 'running'; job.attempts++; job.fence = randomUUID(); job.lease = Date.now() + minutesTimeoutMs(job) + 60000;
      jobClaim = structuredClone(job); emit(r, 'minutes.running', { jobId: job.id });
    });
    if (jobClaim) {
      try {
        let json = '', lastPublished = 0, previewStream, previewTimer, previewRuntime;
      let publishing, previewDirty=false, previewClosed=false;
      const schedulePreview=()=>{
        if(previewClosed || publishing || previewTimer || !previewDirty)return;
        const remaining=1000-(Date.now()-lastPublished);
        if(remaining<=0)void publishPreview();
        else previewTimer=setTimeout(()=>{previewTimer=undefined;void publishPreview();},remaining);
      };
      const publishPreview=()=>{
        if(previewClosed || publishing || !previewDirty)return publishing;
        previewDirty=false;
        const text=json,runtime=previewRuntime;
        publishing=repo.change(candidate.id,r=>updateMinutesPreview(r,jobClaim.id,jobClaim.fence,text,runtime))
          .catch(error=>telemetry.event('minutes.preview-failed',{recordId:candidate.id,jobId:jobClaim.id,error:error.code || 'preview_write_failed'}))
          .finally(()=>{publishing=undefined;lastPublished=Date.now();schedulePreview();});
        return publishing;
      };
      const generate=providers.minutes || (realtimeEnabled(config) && jobClaim.mode !== 'extractive' ? (job,env,opts)=>generateRealtimeMinutes(repo,candidate.id,job,env,opts,providers.realtimeFactory) : doubaoAudioEnabled(config) && jobClaim.mode !== 'extractive' ? (job,env,opts)=>generateDoubaoAudioMinutes(repo,candidate.id,job,env,opts) : generateMinutes);
        const processMinutes=config.RECORD_MINUTES_PIPELINE_ENABLED==='false' ? async(job,env,opts)=>({...await meteredMinutesCall(repo,candidate.id,job,generate,job,env,opts),usageRecorded:true}) : (job,env,opts)=>runMinutesPipeline(repo,candidate.id,job,env,generate,opts);
        let result;
      try {
        result=await telemetry.measure('minutes.complete',{recordId:candidate.id,jobId:jobClaim.id,revision:jobClaim.transcriptRevision,queueMs:Date.now()-Date.parse(jobClaim.createdAt)},()=>processMinutes(jobClaim,config,{
          onDelta:(delta,runtime,stream)=>{
            if(stream!==previewStream){clearTimeout(previewTimer);previewTimer=undefined;json='';lastPublished=0;previewStream=stream;}
            if(!json)telemetry.event('minutes.first-text',{recordId:candidate.id,jobId:jobClaim.id,durationMs:runtime?.firstTokenMs});
            json+=delta;previewRuntime=runtime;previewDirty=true;schedulePreview();
          }
        }));
      } finally {previewClosed=true;clearTimeout(previewTimer);await publishing;}
      telemetry.event('minutes.usage', {recordId:candidate.id, jobId:jobClaim.id, tokens:result.usageTokens, firstTextMs:result.runtime?.firstTokenMs});
        const committed=await telemetry.measure('minutes.commit',{recordId:candidate.id,jobId:jobClaim.id},()=>repo.change(candidate.id,r=>{commitMinutes(r,jobClaim.id,result,jobClaim.fence);return r.jobs.find(j=>j.id===jobClaim.id).status==='completed';}));
        if(committed)telemetry.event('minutes.committed',{recordId:candidate.id,jobId:jobClaim.id,revision:jobClaim.transcriptRevision});
      } catch (error) {
        await repo.change(candidate.id, r => {
          const job = r.jobs.find(j => j.id === jobClaim.id);
          if (!job || job.fence !== jobClaim.fence || r.deleted) return;
          job.status = error.code==='minutes_snapshot_changed' ? 'stale' : 'failed'; delete job.preview; delete job.partialMinutes; job.snapshot = []; job.error = error.code || 'minutes_request_failed'; job.failedAt=Date.now(); emit(r, 'minutes.failed', { jobId: job.id, error: job.error });
        });
      }
    }
    }
    if (lane !== 'all' && lane !== 'audio') return;
    const latest = await repo.get(candidate.id);
    if (!latest.audioPurged && !latest.retainAudio && latest.capture === 'completed' && latest.chunks.every(c => c.state === 'done') && !needsMinutesAudio(latest)) {
      let purge = false;
      await repo.change(latest.id, r => { if (r.capture === 'completed' && !r.retainAudio && !needsMinutesAudio(r)) { delete r.waveforms; r.audioCleanup = true; purge = true; } });
      if (purge) { await repo.cleanAudio(latest.id); await repo.change(latest.id, r => { delete r.waveforms; r.audioPurged = true; r.audioCleanup = false; }); }
    } else {
      // Objects written before a failed metadata transaction are removed after a one-hour grace period.
      if (Date.now() - (latest.gcAt || 0) > 3600000) {
        await repo.cleanAudio(latest.id, new Set(latest.chunks.filter(c => !c.expired).map(c => c.object)), Date.now() - 3600000);
        await repo.change(latest.id, r => { r.gcAt = Date.now(); });
      }
    }
  }
  if (lane === 'all') await processWorkspaceAnalysis(repo, config, providers);
  let next = 0;
  const concurrency = Math.max(1, Math.min(8, Number(process.env.RECORD_WORKER_CONCURRENCY || 3)));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < records.length) await processCandidate(records[next++]);
  }));
}
export async function startWorker() {
  const repo = await createRepository(); let stop = false;
  process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
  console.log(`[record-worker] ${repo.backend}; durable audio and minutes queue`);
  await Promise.all(['audio', 'realtime', 'minutes', 'intents', 'translation', 'workspace', 'learning'].map(async lane => {
  while (!stop) {
   try { await runCycle(repo, {}, { lane }); } catch (e) { console.error('[record-worker]', lane, e.code || e.name); }
   await new Promise(resolve => setTimeout(resolve, lane === 'audio' ? 250 : 500));
  }
 }));
  closeSpeakerStreams(repo);closeRealtime(repo);
  await repo.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await startWorker();

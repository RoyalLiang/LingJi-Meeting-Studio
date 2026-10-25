import { emit, requestMinutes, requireThat } from './record.mjs';

export function setAutomation(record, input, now = Date.now()) {
 requireThat(typeof input.enabled === 'boolean', 'invalid_automation', 400);
 const intervalSeconds = Number(input.intervalSeconds || record.autoMinutes?.intervalSeconds || 30);
 requireThat([15, 30, 60, 120].includes(intervalSeconds), 'invalid_automation_interval', 400);
 if (input.realtimeAudioConsent === true) record.realtimeAudioConsent = true;
  record.autoMinutes = { ...record.autoMinutes, enabled: input.enabled, intervalSeconds, enabledAt: now };
 if (!input.enabled) for (const job of record.jobs) if (job.automatic && ['queued', 'running'].includes(job.status)) {
  job.status = 'cancelled'; job.fence = null; job.snapshot = []; delete job.preview; delete job.partialMinutes;
 }
 emit(record, 'minutes.automation', { enabled: input.enabled });
}
const recoverableMinutesError = /^(?:llm_timeout|llm_connection_failed|llm_stream_incomplete|llm_stream_failed|invalid_llm_response|invalid_minutes_schema|provider_rate_limited|provider_http_5\d\d)$/;

function checkpointJob(record, scope) {
  return record.jobs.filter(job => (scope === 'live' ? job.scope === 'live' : job.scope !== 'live') && job.transcriptRevision === record.transcriptRevision && job.notesRevision === record.notesRevision).at(-1);
}

export function automaticMinutesAt(record, now = Date.now()) {
  const auto = record.autoMinutes;
  if (!auto?.enabled || record.deleted || !record.segments.length || record.minutes?.edited) return Infinity;
  const scope = record.capture === 'completed' ? 'final' : 'live';
  if (record.jobs.some(job => ['queued', 'running'].includes(job.status) && (scope === 'live' || job.scope !== 'live'))) return Infinity;
  const paused = record.capture === 'paused';
  // A pause remains resumable; catch up only after the saved audio tail has drained.
  if (paused && (record.sources.some(source => !source.stopped || source.watermark !== source.lastSequence) || record.chunks.some(chunk => chunk.state !== 'done'))) return Infinity;
  if (scope === 'final' || paused || (auto.lastRevision === record.transcriptRevision && auto.lastScope === scope)) {
    const latest = checkpointJob(record, scope);
    if (!latest) return now;
    const attempt = latest.retryAttempt || 1;
    if (latest.status !== 'failed' || latest.mode !== 'model' || !recoverableMinutesError.test(latest.error || '') || attempt >= 3 || latest.baseMinutesRevision !== record.minutesRevision) return Infinity;
    const failedAt = latest.failedAt ?? (latest.automatic ? auto.lastRequestedAt : undefined) ?? Date.parse(latest.createdAt);
    return failedAt + 15000 * 2 ** (attempt - 1);
  }
  return Math.max(auto.enabledAt || Date.parse(record.createdAt), auto.lastRequestedAt || 0) + auto.intervalSeconds * 1000;
}

export function queueAutomaticMinutes(record, modelVersion, now = Date.now()) {
  if (automaticMinutesAt(record, now) > now) return;
  const scope = record.capture === 'completed' ? 'final' : 'live';
  const previous = checkpointJob(record, scope);
  const job = requestMinutes(record, { mode: 'model', scope, automatic: true, modelVersion, ...(previous?.status === 'failed' ? {template: previous.template} : {}) });
  if (record.capture === 'paused') job.pausedCheckpoint = true;
  if (previous?.status === 'failed' && previous.modelVersion === job.modelVersion) {
    job.retryAttempt = (previous.retryAttempt || 1) + 1;
    job.retryOf = previous.retryOf || previous.id;
  } else job.retryAttempt = 1;
  record.autoMinutes = { ...record.autoMinutes, lastRevision: record.transcriptRevision, lastScope: scope, lastRequestedAt: now };
  return job;
}

export function minutesPreview(json) {
 const blocks = []; const pattern = /"(title|heading|text|summary)"\s*:\s*"((?:[^"\\]|\\.)*)("|$)/g;
 for (const match of json.matchAll(pattern)) {
  let value; try { value = JSON.parse(`"${match[2]}"`); } catch { continue; }
  if (value.trim()) blocks.push({ kind: match[1], text: value.slice(0, 8000) });
  if (blocks.length >= 100) break;
 }
 return blocks;
}
export function updateMinutesPreview(record, jobId, fence, json, runtime) {
 const job = record.jobs.find(j => j.id === jobId);
 if (!job || record.deleted || job.generation !== record.generation || job.fence !== fence || job.status !== 'running') return;
 job.preview = minutesPreview(json); job.runtime = runtime;
 emit(record, 'minutes.delta', { jobId });
}

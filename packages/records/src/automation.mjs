import { emit, requestMinutes, requireThat } from './record.mjs';

export function setAutomation(record, input, now = Date.now()) {
 requireThat(typeof input.enabled === 'boolean', 'invalid_automation', 400);
 const intervalSeconds = Number(input.intervalSeconds || record.autoMinutes?.intervalSeconds || 30);
 requireThat([15, 30, 60, 120].includes(intervalSeconds), 'invalid_automation_interval', 400);
 record.autoMinutes = { ...record.autoMinutes, enabled: input.enabled, intervalSeconds, enabledAt: now };
 if (!input.enabled) for (const job of record.jobs) if (job.automatic && ['queued', 'running'].includes(job.status)) {
  job.status = 'cancelled'; job.fence = null; job.snapshot = []; delete job.preview;
 }
 emit(record, 'minutes.automation', { enabled: input.enabled });
}
export function automaticMinutesAt(record, now = Date.now()) {
 const auto = record.autoMinutes;
 if (!auto?.enabled || record.deleted || !record.segments.length || record.minutes?.edited) return Infinity;
 const scope = record.capture === 'completed' ? 'final' : 'live';
 if(record.jobs.some(j=>['queued','running'].includes(j.status) && (scope==='live' || j.scope!=='live')))return Infinity;
 if (scope === 'final') {
  const latest=record.jobs.filter(job=>job.scope!=='live' && job.transcriptRevision===record.transcriptRevision && job.notesRevision===record.notesRevision).at(-1);
  if(!latest)return now;
  const transient=/^(?:llm_timeout|llm_connection_failed|llm_stream_incomplete|llm_stream_failed|provider_rate_limited|provider_http_5\d\d)$/.test(latest.error || '');
  const attempt=latest.retryAttempt || 1;
  if(latest.status!=='failed' || latest.mode!=='model' || !transient || attempt>=3 || latest.baseMinutesRevision!==record.minutesRevision)return Infinity;
  const failedAt=latest.failedAt ?? (latest.automatic ? auto.lastRequestedAt : undefined) ?? Date.parse(latest.createdAt);
  return failedAt+15000*2**(attempt-1);
 }
 if (auto.lastRevision === record.transcriptRevision && auto.lastScope === scope) return Infinity;
 return Math.max(auto.enabledAt || Date.parse(record.createdAt), auto.lastRequestedAt || 0) + auto.intervalSeconds * 1000;
}
export function queueAutomaticMinutes(record, modelVersion, now = Date.now()) {
 if (automaticMinutesAt(record, now) > now) return;
 const scope = record.capture === 'completed' ? 'final' : 'live';
 const previous=scope==='final' ? record.jobs.filter(job=>job.scope!=='live' && job.transcriptRevision===record.transcriptRevision && job.notesRevision===record.notesRevision).at(-1) : undefined;
 const job = requestMinutes(record, { mode: 'model', scope, automatic: true, modelVersion, ...(previous?.status==='failed' ? {template:previous.template} : {}) });
 if(previous?.status==='failed' && previous.modelVersion===job.modelVersion) {job.retryAttempt=(previous.retryAttempt || 1)+1;job.retryOf=previous.retryOf || previous.id;}
 else job.retryAttempt=1;
 record.autoMinutes = { ...record.autoMinutes, lastRevision: record.transcriptRevision, lastScope: scope, lastRequestedAt: now };
 return job;
}

// A preview is deliberately limited to visible strings. Evidence is trusted only after full validation.
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

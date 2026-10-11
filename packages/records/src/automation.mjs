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
 if (!auto?.enabled || record.deleted || !record.segments.length || record.minutes?.edited || record.jobs.some(j => ['queued', 'running'].includes(j.status))) return Infinity;
 const scope = record.capture === 'completed' ? 'final' : 'live';
 if (auto.lastRevision === record.transcriptRevision && auto.lastScope === scope) return Infinity;
 if (scope === 'final') return now;
 return Math.max(auto.enabledAt || Date.parse(record.createdAt), auto.lastRequestedAt || 0) + auto.intervalSeconds * 1000;
}
export function queueAutomaticMinutes(record, modelVersion, now = Date.now()) {
 if (automaticMinutesAt(record, now) > now) return;
 const scope = record.capture === 'completed' ? 'final' : 'live';
 const job = requestMinutes(record, { mode: 'model', scope, automatic: true, modelVersion });
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

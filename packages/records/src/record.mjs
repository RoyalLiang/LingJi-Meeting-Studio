import { createHash, randomUUID } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export const requireThat = (condition, code, status) => { if (!condition) throw new DomainError(code, status); };
export const digest = data => createHash('sha256').update(data).digest('hex');
export const keyOf = chunk => `${chunk.sessionId}:${chunk.sourceId}:${chunk.epoch}:${chunk.sequence}`;
export const templates = ['meeting', 'interview', 'lecture'];
export function emit(record, type, payload = {}) {
  record.cursor = String(BigInt(record.cursor) + 1n);
  record.updatedAt = new Date().toISOString();
  record.events.push({ cursor: record.cursor, type, payload, at: record.updatedAt });
  record.events = record.events.slice(-1000);
}
export function createRecord(owner, input = {}) {
  const days = Number(input.retentionDays ?? 30);
  requireThat([1, 7, 30, 90].includes(days), 'invalid_retention', 400);
  const now = new Date().toISOString();
  const record = { id: randomUUID(), owner, kind: 'record', title: String(input.title || '未命名会议').slice(0, 160),
    language: input.language || 'zh', createdAt: now, updatedAt: now, cursor: '0', events: [], generation: 1,
    capture: 'idle', transcription: 'idle', sessions: [], sources: [], chunks: [], segments: [], transcriptRevision: 0,
    notes: '', notesRevision: 0, minutes: null, liveMinutes: null, autoMinutes: { enabled: input.autoMinutes === true, intervalSeconds: 30 }, minutesRevision: 0, minutesHistory: [], jobs: [], shares: [],
    retentionDays: days, retainAudio: input.retainAudio === true, deleteAt: new Date(Date.now() + days * 86400000).toISOString(),
    usage: { samples: 0, sampleRate: 16000, llmTokens: 0 }, deleted: false };
  emit(record, 'record.created'); return record;
}
export function addSource(record, input) {
  requireThat(!record.deleted, 'record_deleted', 410);
  requireThat(record.capture !== 'sealed', 'record_draining');
  requireThat(!record.audioCleanup, 'audio_cleanup_in_progress'); record.audioPurged = false;
  requireThat(['microphone', 'display', 'import'].includes(input.kind), 'invalid_source', 400);
  requireThat(record.sources.length < 100, 'source_limit', 429);
  record.sessions ||= [];
  let session = record.sessions.at(-1);
  if (!session || session.status !== 'recording') { session = { id: randomUUID(), status: 'recording', startedAt: new Date().toISOString() }; record.sessions.push(session); }
  const source = { id: randomUUID(), sessionId: session.id, epoch: randomUUID(), kind: input.kind, label: String(input.label || input.kind).slice(0, 80),
    lastSequence: null, watermark: -1, stopped: false };
  record.sources.push(source); record.capture = 'recording'; record.transcription = 'queued';
  emit(record, 'source.started', { sourceId: source.id }); return source;
}
export function acknowledge(record, chunk) {
  requireThat(!record.deleted, 'record_deleted', 410);
  const source = record.sources.find(s => s.id === chunk.sourceId && s.epoch === chunk.epoch);
  requireThat(source, 'unknown_source', 400);
  requireThat(source.sessionId === chunk.sessionId, 'audio_session_mismatch', 400);
  requireThat(Number.isSafeInteger(chunk.sequence) && chunk.sequence >= 0 && chunk.sequence < 100000, 'invalid_sequence', 400);
  requireThat(Number.isSafeInteger(chunk.sampleOffset) && chunk.sampleOffset >= 0 && Number.isSafeInteger(chunk.sampleCount)
    && chunk.sampleCount > 0 && chunk.sampleCount <= 16000 * 15 && chunk.sampleRate === 16000, 'invalid_audio_timing', 400);
  const key = keyOf(chunk), existing = record.chunks.find(c => c.key === key);
  if (existing) {
    requireThat(existing.digest === chunk.digest && existing.sampleOffset === chunk.sampleOffset && existing.sampleCount === chunk.sampleCount, 'audio_identity_conflict');
    return receipt(record, source);
  }
  requireThat(source.lastSequence === null || chunk.sequence <= source.lastSequence, 'outside_sealed_manifest');
  requireThat(!record.audioCleanup, 'audio_cleanup_in_progress');
  requireThat(!source.stopped || source.lastSequence !== null, 'source_stopped');
  requireThat(record.chunks.length < 10000, 'record_chunk_limit', 429);
  requireThat(record.usage.samples + chunk.sampleCount <= 16000 * 60 * 120, 'record_duration_limit', 429);
  const left = record.chunks.find(c => c.sourceId === source.id && c.sequence === chunk.sequence - 1);
  const right = record.chunks.find(c => c.sourceId === source.id && c.sequence === chunk.sequence + 1);
  requireThat((chunk.sequence !== 0 || chunk.sampleOffset === 0) && (!left || left.sampleOffset + left.sampleCount === chunk.sampleOffset)
    && (!right || chunk.sampleOffset + chunk.sampleCount === right.sampleOffset), 'audio_timeline_conflict');
  record.chunks.push({ ...chunk, key, state: 'pending', attempts: 0, acceptedAt: Date.now() });
  record.usage.samples += chunk.sampleCount;
  const sequences = new Set(record.chunks.filter(c => c.sourceId === source.id).map(c => c.sequence));
  while (sequences.has(source.watermark + 1)) source.watermark++;
  record.transcription = 'queued'; emit(record, 'audio.durable', { sourceId: source.id, watermark: source.watermark });
  return receipt(record, source);
}
export function receipt(record, source) {
  const highest = source.lastSequence ?? Math.max(-1, ...record.chunks.filter(c => c.sourceId === source.id).map(c => c.sequence));
  const present = new Set(record.chunks.filter(c => c.sourceId === source.id).map(c => c.sequence));
  const missing = []; for (let i = source.watermark + 1; i <= highest; i++) if (!present.has(i)) missing.push(i);
  return { durable: true, sourceId: source.id, epoch: source.epoch, watermark: source.watermark, missing, cursor: record.cursor };
}
export function seal(record, manifest) {
  requireThat(Array.isArray(manifest) && manifest.length === record.sources.length, 'incomplete_manifest', 400);
  const ids = new Set(manifest.map(m => m.sourceId));
  requireThat(ids.size === manifest.length, 'duplicate_manifest_source', 400);
  for (const source of record.sources) {
    const entry = manifest.find(m => m.sourceId === source.id && m.epoch === source.epoch);
    requireThat(entry && Number.isInteger(entry.lastSequence) && entry.lastSequence >= -1 && entry.lastSequence < 100000, 'invalid_manifest', 400);
    requireThat(source.lastSequence === null || source.lastSequence === entry.lastSequence, 'manifest_immutable');
    requireThat(!record.chunks.some(c => c.sourceId === source.id && c.sequence > entry.lastSequence), 'manifest_precedes_received_audio');
    source.lastSequence = entry.lastSequence; source.stopped = true;
  }
  for (const session of record.sessions || []) if (session.status === 'recording') session.status = 'sealed';
  record.capture = 'sealed'; emit(record, 'capture.sealed'); finalize(record);
}
export function finalize(record) {
  if (record.capture !== 'sealed') return;
  const complete = record.sources.every(s => s.watermark === s.lastSequence)
    && record.chunks.every(c => c.state === 'done');
  if (complete) { for (const session of record.sessions || []) { session.status = 'completed'; session.endedAt ||= new Date().toISOString(); } record.capture = 'completed'; record.transcription = 'ready'; emit(record, 'record.finalized', { transcriptRevision: record.transcriptRevision }); }
}
export function commitTranscript(record, chunkKey, text, generation, translation = null) {
  requireThat(!record.deleted && record.generation === generation, 'stale_generation', 410);
  const chunk = record.chunks.find(c => c.key === chunkKey);
  requireThat(chunk, 'chunk_not_found', 404);
  if (chunk.state === 'done') return;
  if (text.trim()) record.segments.push({ id: randomUUID(), revision: 1, sourceId: chunk.sourceId, chunkKey,
    startMs: chunk.sampleOffset / 16, endMs: (chunk.sampleOffset + chunk.sampleCount) / 16,
    text: text.trim(), speaker: '', translation, edited: false });
  chunk.state = 'done'; delete chunk.error; delete chunk.lease;
  record.transcriptRevision++; record.transcription = 'processing';
  emit(record, 'transcript.committed', { transcriptRevision: record.transcriptRevision }); finalize(record);
}
export function editSegment(record, id, input) {
  const segment = record.segments.find(s => s.id === id);
  requireThat(segment, 'segment_not_found', 404);
  requireThat(segment.revision === input.revision, 'segment_revision_conflict');
  requireThat(typeof input.text === 'string' && input.text.trim() && input.text.length <= 8000, 'invalid_segment_text', 400);
  const { versions, ...previous } = segment;
  segment.versions = [...(versions || []), previous].slice(-20);
  segment.text = input.text.trim(); segment.speaker = String(input.speaker ?? segment.speaker).slice(0, 80);
  if (input.speaker != null) {
    // Keep the acoustic replay anchor separate from a human attribution correction.
    if (segment.speakerId) segment.speakerAnchorId ||= segment.speakerId;
    const known = record.speakers?.find(s => s.label === segment.speaker);
    if (known) { segment.speakerId = known.id; segment.speakerHash = known.hash || digest(`meeting-speaker:v1:${record.id}:${known.id}`); }
    else if (!segment.speaker) { segment.speakerId = null; segment.speakerHash = null; }
  }
  for (const field of ['translation', 'translationLanguage', 'translationLease', 'translationAttempts', 'translationRetryAt', 'translationError']) delete segment[field];
  segment.revision++; segment.edited = true; record.transcriptRevision++;
  emit(record, 'transcript.edited', { segmentId: id, transcriptRevision: record.transcriptRevision });
}
export function requestMinutes(record, input = {}) {
  const scope = input.scope || 'final';
  requireThat(['live', 'final'].includes(scope), 'invalid_minutes_scope', 400);
  requireThat(scope === 'live' || record.capture === 'completed', 'record_not_finalized');
  requireThat(record.segments.length > 0, 'empty_transcript');
  const template = input.template || 'meeting'; requireThat(templates.includes(template), 'unknown_template', 400);
  const snapshot = (scope === 'live' ? record.segments.slice(-120) : record.segments).map(({versions, ...s}) => ({ ...s }));
  const manifestHash = digest(JSON.stringify(snapshot));
  const key = `${record.id}:${record.transcriptRevision}:${manifestHash}:${template}:v1:${record.notesRevision}:${input.modelVersion || 'default'}:${input.mode || 'model'}:${scope}`;
  const existing = record.jobs.find(j => j.key === key && !['failed', 'stale'].includes(j.status));
  if (existing) return existing;
  requireThat(record.jobs.filter(j => ['queued', 'running'].includes(j.status)).length < 3, 'job_limit', 429);
  const job = { id: randomUUID(), key, status: 'queued', transcriptRevision: record.transcriptRevision, notesRevision: record.notesRevision,
    baseMinutesRevision: record.minutesRevision, generation: record.generation, template, scope, automatic: input.automatic === true, mode: input.mode || 'model', modelVersion: input.modelVersion || 'default', snapshot, notes: record.notes, manifestHash,
    createdAt: new Date().toISOString(), attempts: 0 };
  record.jobs.push(job); emit(record, 'minutes.queued', { jobId: job.id }); return job;
}
export function validateMinutes(result, snapshot) {
  requireThat(result && typeof result.title === 'string' && result.title.trim() && result.title.length <= 300 && Array.isArray(result.sections) && result.sections.length <= 20, 'invalid_minutes_schema', 422);
  requireThat(result.sections.length > 0, 'empty_minutes', 422);
  for (const section of result.sections) {
    requireThat(typeof section.heading === 'string' && section.heading.length <= 200 && Array.isArray(section.items) && section.items.length <= 100, 'invalid_minutes_section', 422);
    for (const item of section.items) {
      requireThat(typeof item.text === 'string' && item.text.trim() && item.text.length < 8000 && Array.isArray(item.evidence) && item.evidence.length > 0, 'missing_evidence', 422);
      for (const ref of item.evidence) requireThat(snapshot.some(s => s.id === ref.segmentId && s.revision === ref.revision), 'unknown_evidence', 422);
    }
  }
  if (result.topics !== undefined) {
    requireThat(Array.isArray(result.topics) && result.topics.length <= 30, 'invalid_minutes_topics', 422);
    for (const topic of result.topics) requireThat(typeof topic.title === 'string' && topic.title.trim() && topic.title.length <= 200 && typeof topic.summary === 'string' && topic.summary.length <= 4000 && Array.isArray(topic.evidence) && topic.evidence.length > 0 && topic.evidence.length <= 500 && topic.evidence.every(ref => snapshot.some(s => s.id === ref.segmentId && s.revision === ref.revision)), 'invalid_minutes_topics', 422);
  }
  requireThat(!result.actions || (Array.isArray(result.actions) && result.actions.length <= 100 && result.actions.every(a => typeof a.text === 'string' && a.text.trim() && a.text.length <= 8000 && (a.owner == null || (typeof a.owner === 'string' && a.owner.length <= 100)) && (a.due == null || (typeof a.due === 'string' && a.due.length <= 100))
    && Array.isArray(a.evidence) && a.evidence.length && a.evidence.every(ref => snapshot.some(s => s.id === ref.segmentId && s.revision === ref.revision)))), 'invalid_actions', 422);
  return result;
}
export function commitMinutes(record, jobId, result, fence) {
  const job = record.jobs.find(j => j.id === jobId);
  requireThat(job && !record.deleted && job.generation === record.generation && job.fence === fence, 'stale_job', 410);
  validateMinutes(result, job.snapshot);
  job.runtime = result.runtime || job.runtime;
  const transcriptChanged = job.scope === 'live' ? job.snapshot.some(s => !record.segments.some(current => current.id === s.id && current.revision === s.revision)) : job.transcriptRevision !== record.transcriptRevision;
  if (transcriptChanged || job.notesRevision !== record.notesRevision || job.baseMinutesRevision !== record.minutesRevision) {
    job.status = 'stale'; delete job.preview; job.snapshot = []; emit(record, 'minutes.stale', { jobId }); return;
  }
  if (job.scope === 'live') {
    record.liveMinutes = { ...result, actions: result.actions || [], transcriptRevision: job.transcriptRevision, evidenceSnapshot: job.snapshot, generatedAt: new Date().toISOString() };
    job.status = 'completed'; job.snapshot = []; delete job.preview;
    record.usage.llmTokens += Number.isSafeInteger(result.usageTokens) && result.usageTokens >= 0 ? result.usageTokens : 0;
    emit(record, 'minutes.live', { transcriptRevision: job.transcriptRevision }); return;
  }
  if (record.minutes) record.minutesHistory = [...(record.minutesHistory || []), record.minutes].slice(-10);
  record.minutesRevision++;
  record.minutes = { ...result, actions: result.actions || [], revision: record.minutesRevision, transcriptRevision: job.transcriptRevision, manifestHash: job.manifestHash,
    evidenceSnapshot: job.snapshot, edited: false, generatedAt: new Date().toISOString() };
  job.status = 'completed'; job.snapshot = []; delete job.preview; record.usage.llmTokens += Number.isSafeInteger(result.usageTokens) && result.usageTokens >= 0 ? result.usageTokens : 0;
  emit(record, 'minutes.committed', { revision: record.minutesRevision });
}
export function publicRecord(record) {
  const { owner, events, chunks, shares, jobs, minutesHistory, ...rest } = record;
  return { ...rest, sources: record.sources.map(({asr,...source})=>({...source,...(asr ? {asr:{state:asr.state,error:asr.error,identityWarning:asr.identityWarning,preview:asr.preview,runtime:asr.runtime}} : {})})), audio: record.sources.map(s => receipt(record, s)),
    pendingChunks: chunks.filter(c => c.state !== 'done').length,
    minuteVersions: [...(minutesHistory || []), ...(record.minutes ? [record.minutes] : [])].map(m => ({ revision: m.revision, transcriptRevision: m.transcriptRevision, edited: m.edited })),
    jobs: jobs.map(({ snapshot, notes, fence, ...job }) => job) };
}

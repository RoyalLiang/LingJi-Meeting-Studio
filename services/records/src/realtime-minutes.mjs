import { audioMinutesInstructions as instructions } from './audio-minutes.mjs';
import { createHash } from 'node:crypto';
import { openRealtime } from './openai-realtime.mjs';
import { configured, normalizeConfig } from './config.mjs';
import { emit, requireThat, validateMinutes } from '../../../packages/records/src/record.mjs';

const owners = new WeakMap();
const entries = repo => { if (!owners.has(repo)) owners.set(repo, new Map()); return owners.get(repo); };
const fingerprint = config => createHash('sha256').update(JSON.stringify([config.OPENAI_REALTIME_URL, config.OPENAI_REALTIME_MODEL, config.OPENAI_REALTIME_API_KEY])).digest('hex');
const MAX_AUDIO_SAMPLES = 16000 * 300;
const MAX_AGE_MS = 5 * 60 * 1000;
const sourceTime = (record, chunk) => (record.sources.find(source => source.id === chunk.sourceId)?.timelineOffsetMs || 0) + chunk.sampleOffset / 16;
export const realtimeEnabled = config => config.MINUTES_MODE === 'openai-realtime';
export const realtimeConfigured = config => Boolean(config.OPENAI_REALTIME_URL && config.OPENAI_REALTIME_MODEL && configured(config.OPENAI_REALTIME_API_KEY));

export function closeRealtime(repo, recordId) {
  for (const [key, entry] of entries(repo)) if (!recordId || key === recordId) { entry.closed = true; entry.client.close(); entries(repo).delete(key); }
}

function newEntry(record, config, factory) {
  return { client: factory(config), generation: record.generation, fingerprint: fingerprint(config), createdAt: Date.now(), samples: 0, audio: new Map(), tail: Promise.resolve(), pending: 0, closed: false };
}
function serial(entry, work) {
  entry.pending++;
  const result = entry.tail.then(() => { requireThat(!entry.closed, 'realtime_connection_closed', 502); return work(); });
  entry.tail = result.catch(() => {}).finally(() => { entry.pending--; });
  return result;
}
export async function reconcileRealtime(repo, config) {
  for (const [recordId, entry] of entries(repo)) {
    const record = await repo.get(recordId);
    const invalid = !realtimeEnabled(config) || !realtimeConfigured(config) || !record || record.deleted || Date.parse(record.deleteAt) <= Date.now() || record.generation !== entry.generation || !record.autoMinutes?.enabled || !record.realtimeAudioConsent || record.minutes?.edited || entry.fingerprint !== fingerprint(config);
    const idle = !entry.pending && (record?.capture === 'completed' || Date.now() - entry.createdAt >= MAX_AGE_MS || entry.samples >= MAX_AUDIO_SAMPLES);
    if (invalid || idle) closeRealtime(repo, recordId);
  }
}
function sharedEntry(repo, record, config, factory) {
  let entry = entries(repo).get(record.id);
  if (entry && !entry.pending && (entry.generation !== record.generation || entry.fingerprint !== fingerprint(config) || Date.now() - entry.createdAt >= MAX_AGE_MS || entry.samples >= MAX_AUDIO_SAMPLES)) { closeRealtime(repo, record.id); entry = null; }
  if (!entry) { entry = newEntry(record, config, factory); entries(repo).set(record.id, entry); }
  return entry;
}
async function feed(repo, record, entry, chunks) {
  // At most 15s per committed item; reconnects replay local bytes into a fresh session.
  for (const chunk of chunks) {
    if (entry.audio.has(chunk.key)) continue;
    requireThat(!chunk.expired && chunk.object, 'realtime_audio_unavailable', 409);
    const bytes = await repo.readAudio(chunk.object);
    requireThat(bytes.length === chunk.sampleCount * 2, 'invalid_realtime_audio', 422);
    const itemId = await entry.client.audio(bytes);
    entry.audio.set(chunk.key, { itemId, sourceId: chunk.sourceId, epoch: chunk.epoch, sequence: chunk.sequence, startMs: sourceTime(record, chunk), endMs: sourceTime(record, chunk) + chunk.sampleCount / 16 });
    entry.samples += chunk.sampleCount;
  }
}

// This lane never waits for ASR, and never changes ASR chunk states or its ACK.
export async function processRealtimeAudio(repo, record, config, factory = openRealtime) {
  if (!realtimeEnabled(config) || !record.autoMinutes?.enabled || !record.realtimeAudioConsent || record.deleted || record.audioPurged || record.minutes?.edited) { closeRealtime(repo, record.id); return; }
  if (record.capture === 'completed') { if (!entries(repo).get(record.id)?.pending) closeRealtime(repo, record.id); return; }
  if (!realtimeConfigured(config) || !record.chunks.length) return;
  if ((record.realtime?.retryAt || 0) > Date.now()) return;
  const limit = Math.max(1, Math.min(16, Number(config.RECORD_REALTIME_MAX_STREAMS) || 4));
  if (!entries(repo).has(record.id) && entries(repo).size >= limit) return;
  const entry = sharedEntry(repo, record, config, factory);
  try {
    await serial(entry, async () => {
      const active = await repo.get(record.id);
      requireThat(active && !active.deleted && active.generation === entry.generation && active.autoMinutes?.enabled && active.realtimeAudioConsent, 'stale_job', 410);
      // A fresh connection needs a bounded recent context, not the entire meeting.
      const durable = active.chunks.filter(chunk => !chunk.expired && chunk.sequence <= (active.sources.find(source => source.id === chunk.sourceId)?.watermark ?? -1));
      const end = durable.reduce((latest, chunk) => Math.max(latest, sourceTime(active, chunk) + chunk.sampleCount / 16), 0);
      const selected = durable.filter(chunk => sourceTime(active, chunk) + chunk.sampleCount / 16 > end - 120000 && !entry.audio.has(chunk.key)).sort((a,b) => sourceTime(active,a) - sourceTime(active,b) || a.sequence - b.sequence).slice(0,8);
      await feed(repo, active, entry, selected);
      if (!selected.length) return;
      await repo.change(record.id, current => {
        if (current.deleted || current.generation !== entry.generation || entry.closed || !current.autoMinutes?.enabled) return;
        current.realtime = { state: 'listening', model: config.OPENAI_REALTIME_MODEL, audioThroughMs: [...entry.audio.values()].reduce((latest, item) => Math.max(latest, item.endMs), 0), sessionStartedAt: new Date(entry.createdAt).toISOString() };
        emit(current, 'realtime.audio');
      });
    });
  } catch (error) {
    // An unacknowledged append is never treated as delivered to the model.
    if (entries(repo).get(record.id) === entry) closeRealtime(repo, record.id);
    await repo.change(record.id, current => {
      if (current.deleted || current.generation !== record.generation || !current.autoMinutes?.enabled) return;
      current.realtime = { state: 'blocked', error: error.code || 'realtime_connection_failed', retryAt: Date.now() + 5000 };
      emit(current, 'realtime.blocked');
    });
  }
}



export async function generateRealtimeMinutes(repo, recordId, job, input, options = {}, factory = openRealtime) {
  const config = normalizeConfig(input);
  requireThat(realtimeConfigured(config), 'realtime_not_configured', 503);
  const record = await repo.get(recordId);
  requireThat(record && !record.deleted && record.generation === job.generation, 'stale_job', 410);
  requireThat(record.realtimeAudioConsent, 'realtime_audio_consent_required', 403);
  const refs = job.snapshot || [];
  const chunks = job.stage === 'synthesis' ? [] : record.chunks.filter(chunk => !chunk.expired && refs.some(segment => segment.sourceId === chunk.sourceId && segment.startMs < sourceTime(record,chunk) + chunk.sampleCount / 16 && segment.endMs > sourceTime(record,chunk)));
  requireThat(job.stage === 'synthesis' || chunks.length > 0, 'realtime_audio_unavailable', 409);
  requireThat(chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0) <= MAX_AUDIO_SAMPLES, 'realtime_audio_window_limit', 422);
  let entry = entries(repo).get(recordId);
  const shared = entry && !entry.closed && entry.generation === record.generation && entry.fingerprint === fingerprint(config) && Date.now() - entry.createdAt < MAX_AGE_MS && chunks.length && chunks.every(chunk => entry.audio.has(chunk.key));
  if (!shared) entry = newEntry(record, config, factory);
  try {
    return await serial(entry, async () => {
      await entry.client.ready;
      await feed(repo, record, entry, chunks.sort((a,b) => sourceTime(record,a) - sourceTime(record,b) || a.sequence - b.sequence));
      const audio = chunks.map(chunk => ({ ...entry.audio.get(chunk.key), chunkKey: chunk.key }));
      const data = { transcript: refs, audio, notes: job.notes, context: job.liveContext, summaries: job.summaries, scope: job.scope, template: job.template, stage: job.stage };
      const inputItems = [...new Set(audio.map(item => item.itemId))].map(id => ({ type: 'item_reference', id }));
      inputItems.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify(data) }] });
      const result = await entry.client.respond(inputItems, instructions, { ...options, timeoutMs: job.scope === 'live' ? 120000 : 240000 });
      validateMinutes(result, refs);
      // Preserve the provider/item ↔ durable audio ↔ frozen transcript chain.
      result.audioEvidence = audio.map(({ itemId, sourceId, epoch, sequence, startMs, endMs, chunkKey }) => ({ itemId, sourceId, epoch, sequence, startMs, endMs, chunkKey }));
      return result;
    });
  } catch (error) {
    if (shared && entries(repo).get(recordId) === entry) closeRealtime(repo, recordId);
    throw error;
  } finally { if (!shared) entry.client.close(); }
}

export async function testRealtime(config) {
  const client = openRealtime(normalizeConfig(config));
  try {
    const id = await client.audio(Buffer.alloc(6400));
    return await client.respond([{ type: 'item_reference', id }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic connectivity check. Return JSON {"ok":true}.' }] }], 'Return JSON only. Do not invent speech from silence.');
  } finally { client.close(); }
}

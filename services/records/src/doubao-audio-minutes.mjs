import { normalizeConfig, configured } from './config.mjs';
import { completeModelJson } from './llm.mjs';
import { audioMinutesInstructions } from './audio-minutes.mjs';
import { requireThat, validateMinutes } from '../../../packages/records/src/record.mjs';

const MAX_SAMPLES = 16000 * 300;
export const doubaoAudioConfigured = config => Boolean(config.LLM_PROTOCOL === 'responses' && config.LLM_API_URL && config.LLM_MODEL && configured(config.LLM_API_KEY));
const sourceTime = (record, chunk) => (record.sources.find(source => source.id === chunk.sourceId)?.timelineOffsetMs || 0) + chunk.sampleOffset / 16;

export function pcmWave(bytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + bytes.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

// Compact each bounded source/epoch into one WAV. Silence preserves gaps and the
// local timestamp mapping; audio from different sources is never spliced together.
async function audioClips(repo, record, chunks) {
  const groups = new Map();
  for (const chunk of chunks) {
    const key = JSON.stringify([chunk.sourceId, chunk.epoch]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chunk);
  }
  const clips = [];
  let samples = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => a.sampleOffset - b.sampleOffset);
    const start = group[0].sampleOffset, end = group.reduce((maximum, chunk) => Math.max(maximum, chunk.sampleOffset + chunk.sampleCount), start);
    samples += end - start;
    requireThat(end > start && samples <= MAX_SAMPLES, 'audio_minutes_window_limit', 422);
    const bytes = Buffer.alloc((end - start) * 2);
    const mapping = [];
    for (const chunk of group) {
      const pcm = await repo.readAudio(chunk.object);
      requireThat(pcm.length === chunk.sampleCount * 2, 'audio_minutes_invalid_pcm', 422);
      pcm.copy(bytes, (chunk.sampleOffset - start) * 2);
      mapping.push({ chunkKey: chunk.key, sourceId: chunk.sourceId, epoch: chunk.epoch, sequence: chunk.sequence, startMs: sourceTime(record, chunk), endMs: sourceTime(record, chunk) + chunk.sampleCount / 16 });
    }
    const clipId = `audio-${clips.length + 1}`;
    clips.push({ clipId, sourceId: group[0].sourceId, epoch: group[0].epoch, startMs: sourceTime(record, group[0]), endMs: sourceTime(record, group[0]) + (end - start) / 16, chunks: mapping, audio: { type: 'input_audio', audio_url: `data:audio/wav;base64,${pcmWave(bytes).toString('base64')}` } });
  }
  return clips;
}

export async function generateDoubaoAudioMinutes(repo, recordId, job, input, options = {}) {
  const config = normalizeConfig(input);
  if (job.modelVersion && job.modelVersion !== 'default') config.LLM_MODEL = job.modelVersion.replace(/^doubao-audio:/, '');
  requireThat(doubaoAudioConfigured(config), 'doubao_audio_not_configured', 503);
  const record = await repo.get(recordId);
  requireThat(record && !record.deleted && record.generation === job.generation, 'stale_job', 410);
  requireThat(record.realtimeAudioConsent, 'realtime_audio_consent_required', 403);
  const refs = job.snapshot || [];
  const chunks = job.stage === 'synthesis' ? [] : record.chunks.filter(chunk => !chunk.expired && chunk.sequence <= (record.sources.find(source => source.id === chunk.sourceId && source.epoch === chunk.epoch)?.watermark ?? -1) && refs.some(segment => segment.sourceId === chunk.sourceId && segment.startMs < sourceTime(record, chunk) + chunk.sampleCount / 16 && segment.endMs > sourceTime(record, chunk)));
  requireThat(job.stage === 'synthesis' || chunks.length > 0, 'audio_minutes_audio_unavailable', 409);
  const clips = await audioClips(repo, record, chunks);
  const data = { transcript: refs, audio: clips.map(({ audio: _audio, ...mapping }) => mapping), notes: job.notes, context: job.liveContext, summaries: job.summaries, scope: job.scope, template: job.template, stage: job.stage };
  const result = await completeModelJson([
    { role: 'system', content: audioMinutesInstructions },
    { role: 'user', content: [...clips.flatMap(clip => [{ type: 'input_text', text: `音频 ${clip.clipId}，对应时间及来源见下方 audio 映射。` }, clip.audio]), { type: 'input_text', text: JSON.stringify(data) }] },
  ], config, { ...options, timeoutMs: job.scope === 'live' ? 120000 : 240000 });
  validateMinutes(result, refs);
  result.audioEvidence = clips.flatMap(clip => clip.chunks.map(chunk => ({ clipId: clip.clipId, ...chunk })));
  result.runtime = { ...result.runtime, inputMode: 'doubao-audio', model: config.LLM_MODEL };
  return result;
}

export async function testDoubaoAudio(input) {
  const config = normalizeConfig(input);
  requireThat(doubaoAudioConfigured(config), 'doubao_audio_not_configured', 503);
  return completeModelJson([{ role: 'user', content: [
    { type: 'input_audio', audio_url: `data:audio/wav;base64,${pcmWave(Buffer.alloc(16000)).toString('base64')}` },
    { type: 'input_text', text: '这是合成静音连接测试。仅输出 JSON {"ok":true}，不要编造会议内容。' },
  ] }], config);
}

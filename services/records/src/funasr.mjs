import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';
import { waveHeader } from './audio-wav.mjs';
import { transcribeLocalAsr } from './local-asr.mjs';

export const funasrConfigured = config => Boolean(config.FUNASR_API_URL && config.FUNASR_MODEL);

// FunASR's OpenAI-compatible endpoint, not SenseVoice api.py's /api/v1/asr.
export async function transcribeFunasr(bytes, record, config) {
  if (config.ASR_PROVIDER === 'sensevoice-local') return transcribeLocalAsr(bytes, config);
  requireThat(funasrConfigured(config), 'funasr_not_configured', 503);
  requireThat(bytes.length > 0 && bytes.length <= 960000 && bytes.length % 2 === 0, 'invalid_funasr_audio', 422);
  const form = new FormData();
  form.append('file', new Blob([waveHeader(bytes.length), bytes], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', config.FUNASR_MODEL);
  form.append('language', ['zh', 'en', 'yue', 'ja', 'ko'].includes(record.language) ? record.language : 'auto');
  const headers = config.FUNASR_API_KEY ? { Authorization: `Bearer ${config.FUNASR_API_KEY}` } : {};
  let response;
  try { response = await fetch(config.FUNASR_API_URL, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(120000) }); }
  catch { throw new DomainError('funasr_service_unavailable', 503); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DomainError([401, 403].includes(response.status) ? 'funasr_credentials_rejected' : response.status === 404 ? 'funasr_endpoint_unavailable' : 'funasr_service_unavailable', 502);
  }
  requireThat(Number(response.headers.get('content-length') || 0) <= 1000000, 'invalid_funasr_response', 502);
  const reader = response.body.getReader(); let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      requireThat(size <= 1000000, 'invalid_funasr_response', 502);
      text += decoder.decode(value, {stream:true});
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  let result; try { result = JSON.parse(text); } catch { throw new DomainError('invalid_funasr_response', 502); }
  requireThat(typeof result?.text === 'string' && result.text.length <= 8000, 'invalid_funasr_response', 502);
  return result.text.replace(/<\|[^|]*\|>/g, '').trim();
}

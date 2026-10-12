import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

export function translationConnection(config) {
  const url = config.DOUBAO_TRANSLATION_API_URL || config.LLM_API_URL;
  return { url, key: config.DOUBAO_TRANSLATION_API_KEY || (url === config.LLM_API_URL ? config.LLM_API_KEY : ''), model: config.DOUBAO_TRANSLATION_MODEL || 'doubao-seed-translation-250915' };
}

// Bound by UTF-8 bytes rather than guessing tokens; never truncate the source.
export function translationChunks(text, limit = 768) {
  if (!Number.isInteger(limit) || limit < 4) throw new RangeError('translation_chunk_limit');
  const chunks = []; let current = '', bytes = 0, boundary = 0, boundaryBytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit && current) {
      const cut = boundaryBytes >= limit / 2 ? boundary : current.length;
      chunks.push(current.slice(0, cut));
      current = current.slice(cut); bytes = Buffer.byteLength(current); boundary = 0; boundaryBytes = 0;
    }
    current += character; bytes += size;
    if (/[\s。！？；，、.!?;,:]/u.test(character)) { boundary = current.length; boundaryBytes = bytes; }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function translateSeedText(text, target, config) {
  const { url, key, model } = translationConnection(config);
  requireThat(url && key && !/^(your[-_]|replace|mock|<|xxx)/i.test(key), 'translation_not_configured', 503);
  requireThat(['zh', 'en', 'ja', 'es', 'fr', 'de'].includes(target), 'invalid_translation_target', 400);
  requireThat(typeof text === 'string' && text.trim() && text.length <= 8000, 'invalid_translation_text', 422);
  const translated = [], deadline = AbortSignal.timeout(120000);
  for (const chunk of translationChunks(text)) {
    let response;
    try {
      response = await fetch(url, { method: 'POST', signal: AbortSignal.any([deadline, AbortSignal.timeout(60000)]), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: chunk, translation_options: { target_language: target } }] }], store: false, stream: false }) });
    } catch { throw new DomainError('translation_connection_failed', 502); }
    if (!response.ok) throw new DomainError(response.status === 401 ? 'translation_credentials_rejected' : response.status === 429 ? 'provider_rate_limited' : `translation_http_${response.status}`, 502);
    const raw = await response.text(); requireThat(raw.length <= 200000, 'invalid_translation', 502);
    let result; try { result = JSON.parse(raw); } catch { throw new DomainError('invalid_translation', 502); }
    requireThat(!result.status || result.status === 'completed', 'translation_incomplete', 502);
    const output = result.output_text || (result.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('');
    requireThat(typeof output === 'string' && output.trim() && output.length <= 20000, 'invalid_translation', 502);
    translated.push(output.trim());
  }
  return translated.join(' ');
}

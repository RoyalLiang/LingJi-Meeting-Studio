import { normalizeConfig, configured } from './config.mjs';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

const outputText = response => response.output_text || (response.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('');

// One interface hides Chat Completions / Responses and buffered / SSE transports.
// Deltas are provisional; only the returned JSON may enter domain validation.
export async function completeModelJson(messages, input = process.env, { onDelta } = {}) {
  const env = normalizeConfig(input), responses = env.LLM_PROTOCOL === 'responses';
  requireThat(configured(env.LLM_API_KEY) && env.LLM_MODEL, 'minutes_not_configured', 503);
  const streaming = typeof onDelta === 'function', started = Date.now();
  const body = responses
    ? { model: env.LLM_MODEL, input: messages, store: false, text: { format: { type: 'json_object' } }, stream: streaming }
    : { model: env.LLM_MODEL, messages, response_format: { type: 'json_object' }, stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}) };
  let response;
  try { response = await fetch(env.LLM_API_URL, { method: 'POST', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new DomainError('llm_connection_failed', 502); }
  if (!response.ok) {
    let code; try { code = (await response.json()).error?.code; } catch { /* Upstream bodies may contain sensitive details. */ }
    throw new DomainError(code === 'InvalidEndpointOrModel.NotFound' ? 'llm_model_unavailable' : response.status === 401 ? 'provider_unauthorized' : response.status === 429 ? 'provider_rate_limited' : `provider_http_${response.status}`, 502);
  }
  let text = '', usageTokens = 0, firstTokenMs = null, completed = false, finishReason;
  const streamed = (response.headers.get('content-type') || '').includes('text/event-stream');
  const append = async delta => {
    requireThat(typeof delta === 'string', 'invalid_llm_response', 502);
    if (!delta) return;
    text += delta; requireThat(text.length <= 1000000, 'llm_response_too_large', 502);
    firstTokenMs ??= Date.now() - started;
    if (onDelta) await onDelta(delta, { firstTokenMs, elapsedMs: Date.now() - started });
  };
  try {
    if (!streamed) {
      const source = await response.text(); requireThat(source.length <= 2000000, 'llm_response_too_large', 502);
      const result = JSON.parse(source);
      requireThat(!responses || !result.status || result.status === 'completed', 'llm_stream_incomplete', 502);
      await append(responses ? outputText(result) : result.choices?.[0]?.message?.content);
      usageTokens = result.usage?.total_tokens || 0; completed = true;
    } else {
      const decoder = new TextDecoder(), reader = response.body.getReader();
      let buffer = '', bytesRead = 0;
      async function frame(value) {
        const data = value.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data === '[DONE]') { if (!responses) completed = true; return; }
        const event = JSON.parse(data);
        if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new DomainError('llm_stream_failed', 502);
        if (responses) {
          if (event.type === 'response.output_text.delta') await append(event.delta);
          if (event.type === 'response.completed') {
            requireThat(!event.response?.status || event.response.status === 'completed', 'llm_stream_incomplete', 502);
            if (!text) await append(outputText(event.response || {}));
            usageTokens = event.response?.usage?.total_tokens || 0; completed = true;
          }
        } else {
          const choice = event.choices?.[0];
          if (choice?.delta?.content) await append(choice.delta.content);
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (event.usage) usageTokens = event.usage.total_tokens || 0;
        }
      }
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytesRead += next.value.length; requireThat(bytesRead <= 4000000, 'llm_response_too_large', 502);
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n');
          let boundary; while ((boundary = buffer.indexOf('\n\n')) >= 0) { const value = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); await frame(value); }
        }
        buffer += decoder.decode(); if (buffer.trim()) await frame(buffer);
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      requireThat(completed && finishReason !== 'length' && finishReason !== 'content_filter', 'llm_stream_incomplete', 502);
    }
    const result = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    requireThat(result && typeof result === 'object' && !Array.isArray(result), 'invalid_llm_response', 502);
    return { ...result, usageTokens: Number.isSafeInteger(usageTokens) && usageTokens >= 0 ? usageTokens : 0, runtime: { protocol: env.LLM_PROTOCOL, streamed, firstTokenMs, durationMs: Date.now() - started } };
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('invalid_llm_response', 502); }
}

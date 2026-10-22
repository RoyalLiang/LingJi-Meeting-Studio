import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../../../packages/records/src/record.mjs';
import { parseAsrHotwords, parseAsrContext } from './asr-terms.mjs';

export const defaults = {
  ASR_PROVIDER: 'doubao',
  MINUTES_MODE: 'asr-llm',
  OPENAI_REALTIME_URL: 'wss://api.openai.com/v1/realtime',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1',
  DOUBAO_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  DOUBAO_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration',
  DOUBAO_AST_BASE_URL: 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate',
  DOUBAO_AST_ENDPOINT: 'v4/ast/v2/translate',
  DOUBAO_AST_RESOURCE_ID: 'volc.service_type.10053',
  LLM_API_URL: 'https://ark.cn-beijing.volces.com/api/v3/responses',
  LLM_PROTOCOL: 'responses',
  DOUBAO_TRANSLATION_MODEL: 'doubao-seed-translation-250915',
};
const fields = ['MINUTES_MODE', 'OPENAI_REALTIME_URL', 'OPENAI_REALTIME_MODEL', 'OPENAI_REALTIME_API_KEY', 'DOUBAO_TRANSLATION_API_URL', 'DOUBAO_TRANSLATION_API_KEY', 'DOUBAO_TRANSLATION_MODEL', 'DOUBAO_ASR_HOTWORDS', 'DOUBAO_ASR_CONTEXT', 'ASR_PROVIDER', 'DOUBAO_API_KEY', 'DOUBAO_ASR_URL', 'DOUBAO_ASR_RESOURCE_ID', 'DOUBAO_AST_BASE_URL', 'DOUBAO_AST_ENDPOINT', 'DOUBAO_AST_RESOURCE_ID', 'DOUBAO_AST_APP_ID', 'DOUBAO_AST_APP_KEY', 'DOUBAO_AST_ACCESS_KEY', 'ASR_API_URL', 'ASR_API_KEY', 'ASR_MODEL', 'DEEPGRAM_API_KEY', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_PROTOCOL'];
const secretFields = new Set(['OPENAI_REALTIME_API_KEY', 'DOUBAO_TRANSLATION_API_KEY', 'DOUBAO_API_KEY', 'DOUBAO_AST_APP_KEY', 'DOUBAO_AST_ACCESS_KEY', 'ASR_API_KEY', 'DEEPGRAM_API_KEY', 'LLM_API_KEY']);
export const configured = value => Boolean(value && !/^(your[-_]|replace|mock|<|xxx)/i.test(value));
export function normalizeConfig(env = process.env) {
  const protocol = env.LLM_PROTOCOL || (/\/chat\/completions\/?(?:\?|$)/.test(env.LLM_API_URL || '') ? 'chat-completions' : defaults.LLM_PROTOCOL);
  return { ...defaults, ...env, LLM_PROTOCOL: protocol, LLM_API_URL: env.LLM_API_URL ?? defaults.LLM_API_URL,
    ASR_PROVIDER: env.ASR_PROVIDER || (env.DEEPGRAM_API_KEY ? 'deepgram' : env.ASR_API_URL ? 'openai-compatible' : env.DOUBAO_AST_APP_KEY || env.DOUBAO_AST_SECRET ? 'doubao-ast' : 'doubao'),
    DOUBAO_AST_APP_KEY: env.DOUBAO_AST_APP_KEY || env.DOUBAO_AST_SECRET || '',
    DOUBAO_AST_ACCESS_KEY: env.DOUBAO_AST_ACCESS_KEY || env.DOUBAO_AST_ACCESS_TOKEN || '',
  };
}
export async function readConfig(root, env = process.env) {
  let saved = {};
  try { saved = JSON.parse(await readFile(join(root, 'providers.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return normalizeConfig({ ...env, ...saved });
}
export function publicConfig(config) {
  return Object.fromEntries(fields.map(key => [key, secretFields.has(key) ? configured(config[key]) : config[key] || '']));
}
export function canConfigure(user, env = process.env) {
  return env.NODE_ENV !== 'production' || (env.RECORD_CONFIG_ADMIN || '').split(',').map(v => v.trim().toLowerCase()).includes(user.email);
}
export async function saveConfig(root, input, env = process.env) {
  const current = await readConfig(root, env), values = {};
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid_provider_config', 400);
  for (const key of fields) {
    if (!(key in input)) continue;
    requireThat(typeof input[key] === 'string' && input[key].length <= 2048 && !/[\r\n]/.test(input[key]), 'invalid_provider_config', 400);
    // A blank password field preserves the configured secret. Clearing is explicit.
    values[key] = secretFields.has(key) && input[key] === '' ? current[key] : input[key].trim();
  }
  for (const key of input.clearSecrets || []) { requireThat(secretFields.has(key), 'invalid_secret_field', 400); values[key] = ''; }
  const next = { ...current, ...values };
  requireThat(['doubao', 'doubao-ast', 'deepgram', 'openai-compatible'].includes(next.ASR_PROVIDER), 'invalid_asr_provider', 400);
  requireThat(['chat-completions', 'responses'].includes(next.LLM_PROTOCOL), 'invalid_llm_protocol', 400);
  requireThat(['asr-llm', 'openai-realtime'].includes(next.MINUTES_MODE), 'invalid_minutes_mode', 400);
  parseAsrHotwords(next.DOUBAO_ASR_HOTWORDS);
  const context=parseAsrContext(next.DOUBAO_ASR_CONTEXT);
  for (const key of ['OPENAI_REALTIME_URL', 'DOUBAO_ASR_URL', 'DOUBAO_AST_BASE_URL', 'ASR_API_URL', 'LLM_API_URL', 'DOUBAO_TRANSLATION_API_URL']) {
    if (!next[key]) continue;
    let url; try { url = new URL(next[key]); } catch { requireThat(false, 'invalid_provider_url', 400); }
    const socketUrl = ['OPENAI_REALTIME_URL', 'DOUBAO_ASR_URL', 'DOUBAO_AST_BASE_URL'].includes(key);
    const protocols = socketUrl ? ['wss:'] : ['https:'];
    if (env.NODE_ENV !== 'production') protocols.push(socketUrl ? 'ws:' : 'http:');
    requireThat(protocols.includes(url.protocol) && !url.username && !url.password && !url.hash, 'invalid_provider_url', 400);
  }
  requireThat(!context || next.ASR_PROVIDER!=='doubao' || new URL(next.DOUBAO_ASR_URL).pathname.endsWith('/bigmodel_async'),'asr_context_requires_second_pass',400);
  let previous = {};
  try { previous = JSON.parse(await readFile(join(root, 'providers.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temporary = join(root, `providers-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...previous, ...values }, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(root, 'providers.json'));
  return publicConfig(next);
}

export const minutesModelVersion = config => config.MINUTES_MODE === 'openai-realtime' ? `openai-realtime:${config.OPENAI_REALTIME_MODEL}` : config.LLM_MODEL;

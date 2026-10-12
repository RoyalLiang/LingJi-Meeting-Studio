import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../../../packages/records/src/record.mjs';
import { parseAsrHotwords } from './asr-terms.mjs';

export const defaults = {
  ASR_PROVIDER: 'doubao',
  DOUBAO_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  DOUBAO_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration',
  DOUBAO_AST_BASE_URL: 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate',
  DOUBAO_AST_ENDPOINT: 'v4/ast/v2/translate',
  DOUBAO_AST_RESOURCE_ID: 'volc.service_type.10053',
  LLM_API_URL: 'https://ark.cn-beijing.volces.com/api/v3/responses',
  LLM_PROTOCOL: 'responses',
};
const fields = ['DOUBAO_ASR_HOTWORDS', 'ASR_PROVIDER', 'DOUBAO_API_KEY', 'DOUBAO_ASR_URL', 'DOUBAO_ASR_RESOURCE_ID', 'DOUBAO_AST_BASE_URL', 'DOUBAO_AST_ENDPOINT', 'DOUBAO_AST_RESOURCE_ID', 'DOUBAO_AST_APP_ID', 'DOUBAO_AST_APP_KEY', 'DOUBAO_AST_ACCESS_KEY', 'ASR_API_URL', 'ASR_API_KEY', 'ASR_MODEL', 'DEEPGRAM_API_KEY', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_PROTOCOL'];
const secretFields = new Set(['DOUBAO_API_KEY', 'DOUBAO_AST_APP_KEY', 'DOUBAO_AST_ACCESS_KEY', 'ASR_API_KEY', 'DEEPGRAM_API_KEY', 'LLM_API_KEY']);
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
  parseAsrHotwords(next.DOUBAO_ASR_HOTWORDS);
  for (const key of ['DOUBAO_ASR_URL', 'DOUBAO_AST_BASE_URL', 'ASR_API_URL', 'LLM_API_URL']) {
    if (!next[key]) continue;
    let url; try { url = new URL(next[key]); } catch { requireThat(false, 'invalid_provider_url', 400); }
    const protocols = key.startsWith('DOUBAO_') ? ['wss:'] : ['https:'];
    if (env.NODE_ENV !== 'production') protocols.push(key.startsWith('DOUBAO_') ? 'ws:' : 'http:');
    requireThat(protocols.includes(url.protocol) && !url.username && !url.password && !url.hash, 'invalid_provider_url', 400);
  }
  let previous = {};
  try { previous = JSON.parse(await readFile(join(root, 'providers.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temporary = join(root, `providers-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...previous, ...values }, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(root, 'providers.json'));
  return publicConfig(next);
}

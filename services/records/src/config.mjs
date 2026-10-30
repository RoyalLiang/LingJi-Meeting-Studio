import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from '../../../packages/records/src/record.mjs';
import { parseAsrHotwords, parseAsrContext } from './asr-terms.mjs';
import { localAsrConfigured, LOCAL_ASR_MODEL } from './local-asr.mjs';
import { learningServiceTarget, validLearningServiceTarget } from '../../../packages/records/src/learning.mjs';

export const defaults = {
  AUTO_MEETING_ENABLED: 'false',
  AUTO_MEETING_BROWSER: 'true',
  AUTO_MEETING_FEISHU: 'true',
  ASR_PROVIDER: 'doubao',
  FUNASR_API_URL: 'http://127.0.0.1:18586/v1/audio/transcriptions',
  FUNASR_MODEL: 'sensevoice',
  MINUTES_MODE: 'asr-llm',
  OPENAI_REALTIME_URL: 'wss://api.openai.com/v1/realtime',
  OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1',
  DOUBAO_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  DOUBAO_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration',
  LLM_API_URL: 'https://ark.cn-beijing.volces.com/api/v3/responses',
  LLM_PROTOCOL: 'responses',
  LLM_REASONING_EFFORT: 'auto',
  DOUBAO_TRANSLATION_MODEL: 'doubao-seed-translation-250915',
  TRANSLATION_PROVIDER: 'auto',
};
const fields = ['AUTO_MEETING_ENABLED', 'AUTO_MEETING_BROWSER', 'AUTO_MEETING_FEISHU', 'LEARNING_SSH_HOST', 'LEARNING_REMOTE_BASE', 'TRANSLATION_PROVIDER', 'FUNASR_API_URL', 'FUNASR_MODEL', 'FUNASR_API_KEY', 'MINUTES_MODE', 'OPENAI_REALTIME_URL', 'OPENAI_REALTIME_MODEL', 'OPENAI_REALTIME_API_KEY', 'DOUBAO_TRANSLATION_API_URL', 'DOUBAO_TRANSLATION_API_KEY', 'DOUBAO_TRANSLATION_MODEL', 'DOUBAO_ASR_HOTWORDS', 'DOUBAO_ASR_CONTEXT', 'ASR_PROVIDER', 'DOUBAO_API_KEY', 'DOUBAO_ASR_URL', 'DOUBAO_ASR_RESOURCE_ID', 'ASR_API_URL', 'ASR_API_KEY', 'ASR_MODEL', 'DEEPGRAM_API_KEY', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_PROTOCOL', 'LLM_REASONING_EFFORT'];
const secretFields = new Set(['FUNASR_API_KEY', 'OPENAI_REALTIME_API_KEY', 'DOUBAO_TRANSLATION_API_KEY', 'DOUBAO_API_KEY', 'ASR_API_KEY', 'DEEPGRAM_API_KEY', 'LLM_API_KEY']);
export const configured = value => Boolean(value && !/^(your[-_]|replace|mock|<|xxx)/i.test(value));
export const reasoningEfforts = ['auto', 'default', 'low', 'medium', 'high', 'xhigh', 'max'];
export function normalizeConfig(env = process.env) {
  const protocol = env.LLM_PROTOCOL || (/\/chat\/completions\/?(?:\?|$)/.test(env.LLM_API_URL || '') ? 'chat-completions' : defaults.LLM_PROTOCOL);
  return { ...defaults, ...env, LLM_PROTOCOL: protocol, LLM_API_URL: env.LLM_API_URL ?? defaults.LLM_API_URL,
    ASR_PROVIDER: env.ASR_PROVIDER === 'doubao-ast' ? 'doubao' : env.ASR_PROVIDER || (env.DEEPGRAM_API_KEY ? 'deepgram' : env.ASR_API_URL ? 'openai-compatible' : env.DOUBAO_API_KEY ? 'doubao' : localAsrConfigured(env) ? 'sensevoice-local' : 'doubao'),
  };
}
export async function readConfig(root, env = process.env) {
  let saved = {};
  try { saved = JSON.parse(await readFile(join(root, 'providers.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return normalizeConfig({ ...env, ...saved });
}
export function publicConfig(config) {
  return { ...Object.fromEntries(fields.map(key => [key, secretFields.has(key) ? configured(config[key]) : config[key] || ''])), LOCAL_ASR_AVAILABLE: localAsrConfigured(config), LOCAL_ASR_MODEL }; 
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
  for(const key of ['AUTO_MEETING_ENABLED','AUTO_MEETING_BROWSER','AUTO_MEETING_FEISHU'])requireThat(['true','false'].includes(next[key]),'invalid_meeting_automation',400);
  requireThat(next.AUTO_MEETING_ENABLED!=='true' || next.AUTO_MEETING_BROWSER==='true' || next.AUTO_MEETING_FEISHU==='true','invalid_meeting_automation',400);
  const learningTarget=learningServiceTarget(next);
  requireThat((!learningTarget.host && !learningTarget.remoteBase) || validLearningServiceTarget(learningTarget),'invalid_learning_service_config',400);
  requireThat(['doubao', 'deepgram', 'openai-compatible', 'funasr', 'sensevoice-local'].includes(next.ASR_PROVIDER), 'invalid_asr_provider', 400);
  requireThat(next.ASR_PROVIDER !== 'sensevoice-local' || localAsrConfigured(next), 'local_asr_assets_missing', 503);
  requireThat(['chat-completions', 'responses'].includes(next.LLM_PROTOCOL), 'invalid_llm_protocol', 400);
  requireThat(['auto','text-model','doubao-seed'].includes(next.TRANSLATION_PROVIDER), 'invalid_translation_provider', 400);
  requireThat(reasoningEfforts.includes(next.LLM_REASONING_EFFORT), 'invalid_llm_reasoning_effort', 400);
  if(next.LLM_STRUCTURED_OUTPUTS!==undefined)requireThat(['true','false'].includes(next.LLM_STRUCTURED_OUTPUTS),'invalid_structured_outputs',400);
  requireThat(['asr-llm', 'openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(next.MINUTES_MODE), 'invalid_minutes_mode', 400);
  requireThat(!doubaoAudioEnabled(next) || next.LLM_PROTOCOL === 'responses', 'doubao_audio_requires_responses', 400);
  parseAsrHotwords(next.DOUBAO_ASR_HOTWORDS);
  const context=parseAsrContext(next.DOUBAO_ASR_CONTEXT);
  for (const key of ['OPENAI_REALTIME_URL', 'DOUBAO_ASR_URL', 'ASR_API_URL', 'LLM_API_URL', 'DOUBAO_TRANSLATION_API_URL', 'FUNASR_API_URL']) {
    if (!next[key]) continue;
    let url; try { url = new URL(next[key]); } catch { requireThat(false, 'invalid_provider_url', 400); }
    const socketUrl = ['OPENAI_REALTIME_URL', 'DOUBAO_ASR_URL'].includes(key);
    const protocols = socketUrl ? ['wss:'] : ['https:'];
    if (key === 'FUNASR_API_URL' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !protocols.includes('http:')) protocols.push('http:');
    if (key === 'FUNASR_API_URL') requireThat(url.pathname.replace(/\/+$/, '').endsWith('/v1/audio/transcriptions'), 'funasr_compatible_endpoint_required', 400);
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

export const minutesModelVersion = config => config.MINUTES_MODE === 'openai-realtime' ? `openai-realtime:${config.OPENAI_REALTIME_MODEL}` : doubaoAudioEnabled(config) ? `${config.MINUTES_MODE}:${config.LLM_MODEL}` : config.LLM_MODEL;

export const audioMinutesEnabled = config => ['openai-realtime', 'doubao-audio', 'doubao-audio-only'].includes(config.MINUTES_MODE);

export const doubaoAudioEnabled = config => ['doubao-audio', 'doubao-audio-only'].includes(config.MINUTES_MODE);

export const meetingAutomationConfig=config=>({enabled:config.AUTO_MEETING_ENABLED==='true',browser:config.AUTO_MEETING_BROWSER!=='false',feishu:config.AUTO_MEETING_FEISHU!=='false'});

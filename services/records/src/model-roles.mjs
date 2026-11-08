import { requireThat } from '../../../packages/records/src/record.mjs';

export const modelRoles = ['translation', 'intents', 'minutesMap', 'minutesFinal', 'analysis'];
const audioModes = new Set(['openai-realtime', 'doubao-audio', 'doubao-audio-only']);

export function parseModelRoles(value = '') {
  requireThat(typeof value === 'string' && value.length <= 20000, 'invalid_model_roles', 400);
  if (!value) return {};
  let routes;
  try { routes = JSON.parse(value); } catch { requireThat(false, 'invalid_model_roles', 400); }
  requireThat(routes && typeof routes === 'object' && !Array.isArray(routes), 'invalid_model_roles', 400);
  for (const [role, model] of Object.entries(routes)) {
    requireThat(modelRoles.includes(role) && typeof model === 'string' && model.length > 0 && model.length <= 200 && model.trim() === model && !/\p{C}/u.test(model), 'invalid_model_roles', 400);
  }
  return routes;
}

export function roleModelConfig(config, role, routes = config.LLM_ROLE_MODELS) {
  requireThat(modelRoles.includes(role), 'invalid_model_role', 400);
  const model = parseModelRoles(routes)[role];
  if (!model) return config;
  const translation = role === 'translation' && (!config.TRANSLATION_PROVIDER || config.TRANSLATION_PROVIDER === 'auto') ? { TRANSLATION_PROVIDER: 'text-model' } : {};
  const facts = Object.hasOwn(config.LLM_ROLE_FACTS || {}, model) ? config.LLM_ROLE_FACTS[model] : model === config.LLM_MODEL ? config.LLM_MODEL_FACTS : undefined;
  if (model === config.LLM_MODEL && !Object.keys(translation).length && facts === config.LLM_MODEL_FACTS) return config;
  // Facts about the default model cannot establish another model's limits or prices.
  return { ...config, ...translation, LLM_MODEL: model, LLM_MODEL_FACTS: facts };
}

export function minutesModelRole(job) {
  return job.stage === 'synthesis' || (job.scope !== 'live' && (!job.stage || job.stage === 'single')) ? 'minutesFinal' : 'minutesMap';
}

export function minutesRoleConfig(job, config, role = minutesModelRole(job)) {
  if (audioModes.has(config.MINUTES_MODE)) return config;
  const base = job.modelVersion && job.modelVersion !== 'default' && job.modelVersion !== config.LLM_MODEL ? { ...config, LLM_MODEL: job.modelVersion, LLM_MODEL_FACTS: Object.hasOwn(config.LLM_ROLE_FACTS || {}, job.modelVersion) ? config.LLM_ROLE_FACTS[job.modelVersion] : undefined } : config;
  return roleModelConfig(base, role, job.modelRouting ?? '');
}

export function minutesModelRouting(config) {
  if (audioModes.has(config.MINUTES_MODE)) return '';
  const routes = parseModelRoles(config.LLM_ROLE_MODELS);
  const selected = Object.fromEntries(['minutesMap', 'minutesFinal'].filter(role => routes[role]).map(role => [role, routes[role]]));
  return Object.keys(selected).length ? JSON.stringify(selected) : '';
}

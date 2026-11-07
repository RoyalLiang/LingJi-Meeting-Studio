import { requireThat,digest } from '../../../packages/records/src/record.mjs';

// An unknown gateway/model deliberately keeps the compatible JSON transport.
// Operators can supply measured catalog facts per exact model, never by name prefix.
export function modelProfile(env) {
  let profiles = {};
  try { profiles = JSON.parse(env.LLM_MODEL_PROFILES || '{}'); } catch { requireThat(false, 'invalid_model_profile', 400); }
  requireThat(profiles&&typeof profiles==='object'&&!Array.isArray(profiles),'invalid_model_profile',400);
  const exact=`${env.LLM_PROTOCOL}:${env.LLM_MODEL}`,value=Object.hasOwn(profiles,exact)?profiles[exact]:Object.hasOwn(profiles,env.LLM_MODEL)?profiles[env.LLM_MODEL]:{};
  requireThat(value&&typeof value==='object'&&!Array.isArray(value),'invalid_model_profile',400);
  for(const flag of ['nativeTools','strictOutput','parallelTools','promptCache'])requireThat(value[flag]===undefined||typeof value[flag]==='boolean','invalid_model_profile',400);
  const integer = (name, fallback, maximum) => {
    const number = value[name] ?? fallback;
    requireThat(Number.isSafeInteger(number) && number >= 1024 && number <= maximum, 'invalid_model_profile', 400);
    return number;
  };
  const prices = value.prices;
  if (prices) for (const [field,price] of Object.entries(prices)) requireThat(['input','output','cacheRead','cacheWrite'].includes(field)&&Number.isFinite(price)&&price>=0,'invalid_model_profile',400);
  const completePrices=prices&&['input','output','cacheRead','cacheWrite'].every(field=>Number.isFinite(prices[field]));
  const contextWindow=integer('contextWindow',16384,2000000),maxOutputTokens=integer('maxOutputTokens',4096,131072);
  requireThat(maxOutputTokens<=contextWindow,'invalid_model_profile',400);
  return { model: env.LLM_MODEL, protocol: env.LLM_PROTOCOL, contextWindow, maxOutputTokens, nativeTools: value.nativeTools === true, strictOutput: value.strictOutput === true, parallelTools: value.parallelTools === true, promptCache: value.promptCache === true, prices: completePrices ? prices : null, source: Object.keys(value).length ? 'configured-catalog' : 'conservative-fallback' };
}

export function piUsage(usage = {}, profile) {
  const cached = usage.cachedInputTokens || 0, input = Math.max(0, (usage.inputTokens || 0) - cached), output = usage.outputTokens || 0;
  const cost = profile.prices ? { input: input * profile.prices.input / 1e6, output: output * profile.prices.output / 1e6, cacheRead: cached * profile.prices.cacheRead / 1e6, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cost.total = Object.values(cost).reduce((a, b) => a + b, 0);
  return { input, output, cacheRead: cached, cacheWrite: 0, totalTokens: usage.totalTokens ?? input + cached + output, cost };
}

export function estimateTask(profile, { characters, pages, maxRounds }) {
  // UTF-8 bytes are a conservative token upper bound, including repeated context.
  const rounds = maxRounds ?? Math.max(2, pages + 2), inputTokens = Math.ceil(characters * 3 + rounds * profile.contextWindow), outputTokens = rounds * profile.maxOutputTokens;
  const cost = profile.prices ? (inputTokens * Math.max(profile.prices.input, profile.prices.cacheRead) + outputTokens * profile.prices.output) / 1e6 : null;
  return { inputTokens, outputTokens, rounds, cost, currency: 'USD', pricingKnown: Boolean(profile.prices) };
}

export const modelConfigFingerprint=config=>digest(JSON.stringify([config.LLM_MODEL,config.LLM_API_URL,config.LLM_PROTOCOL,config.LLM_REASONING_EFFORT,config.LLM_MODEL_PROFILES||'',config.MEETING_TASK_BUDGET_USD||'',config.LLM_API_KEY]));

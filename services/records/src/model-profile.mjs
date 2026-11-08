import { requireThat,digest } from '../../../packages/records/src/record.mjs';

// An unknown gateway/model deliberately keeps the compatible JSON transport.
// Operators can supply measured catalog facts per exact model, never by name prefix.
export function modelProfile(env) {
  let profiles = {};
  try { profiles = JSON.parse(env.LLM_MODEL_PROFILES || '{}'); } catch { requireThat(false, 'invalid_model_profile', 400); }
  requireThat(profiles&&typeof profiles==='object'&&!Array.isArray(profiles),'invalid_model_profile',400);
  const exact=`${env.LLM_PROTOCOL}:${env.LLM_MODEL}`,manual=Object.hasOwn(profiles,exact)?profiles[exact]:Object.hasOwn(profiles,env.LLM_MODEL)?profiles[env.LLM_MODEL]:{},facts=env.LLM_MODEL_FACTS||{},value={...(facts.catalog||{}),...manual};
  requireThat(manual&&typeof manual==='object'&&!Array.isArray(manual),'invalid_model_profile',400);
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
  const declaredContextWindow=integer('contextWindow',16384,2000000),requestedOutput=integer('maxOutputTokens',Math.min(4096,declaredContextWindow),131072);
  requireThat(requestedOutput<=declaredContextWindow,'invalid_model_profile',400);
  const operationalLimit=integer('effectiveContextWindow',262144,2000000);
  const contextWindow=Math.min(declaredContextWindow,operationalLimit,facts.contextLimit||2000000),maxOutputTokens=Math.min(requestedOutput,Math.floor(contextWindow/2));
  return { model: env.LLM_MODEL, protocol: env.LLM_PROTOCOL, declaredContextWindow, contextWindow, maxOutputTokens, nativeTools: value.nativeTools === true, strictOutput: value.strictOutput === true, parallelTools: value.parallelTools === true, promptCache: value.promptCache === true, prices: completePrices ? prices : null, tokenRatios:facts.tokenRatios||{}, evidence:[...(facts.evidence||[]),...Object.entries(manual).map(([field,value])=>({field,value,source:'configured-catalog',at:env.LLM_CONFIG_READ_AT||new Date().toISOString(),confirmed:true}))], source: Object.keys(manual).length ? 'configured-catalog' : facts.catalog?'gateway-unconfirmed':'conservative-fallback' };
}

export function tokenCharacterCounts(text) {
  const value=String(text),cjk=(value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)||[]).length;
  const json=(value.match(/[{}\[\]":,\\]/g)||[]).length;
  return {cjk,json,latin:Math.max(0,value.length-cjk-json)};
}
export function estimateTextTokens(text,profile={}) {
  const counts=tokenCharacterCounts(text),ratios=profile.tokenRatios||{};
  return Math.ceil(counts.cjk*(ratios.cjk||1.5)+counts.json*(ratios.json||0.8)+counts.latin*(ratios.latin||0.4));
}

export function contextPolicy(profile) {
  const reserveTokens=Math.min(Math.floor(profile.contextWindow*.4),profile.maxOutputTokens+Math.max(1024,Math.ceil(profile.contextWindow*.04)));
  const inputTokens=profile.contextWindow-reserveTokens;
  return {reserveTokens,inputTokens,keepRecentTokens:Math.min(16000,Math.floor(inputTokens*.2)),pageChars:Math.max(1024,Math.min(60000,Math.floor(inputTokens*.18))),readBatchSize:profile.contextWindow>=65536?3:1,inlineTokens:Math.floor(inputTokens*.55),shardChars:Math.max(60000,Math.floor(inputTokens*.6)),minutesBytes:Math.max(4096,Math.min(384000,Math.floor(inputTokens*.6)))};
}

export function piUsage(usage = {}, profile) {
  const cached = usage.cachedInputTokens || 0, input = Math.max(0, (usage.inputTokens || 0) - cached), output = usage.outputTokens || 0;
  const cost = profile.prices ? { input: input * profile.prices.input / 1e6, output: output * profile.prices.output / 1e6, cacheRead: cached * profile.prices.cacheRead / 1e6, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cost.total = Object.values(cost).reduce((a, b) => a + b, 0);
  return { input, output, cacheRead: cached, cacheWrite: 0, totalTokens: usage.totalTokens ?? input + cached + output, cost };
}

export function estimateTask(profile, { characters, pages, maxRounds }) {
  const policy=contextPolicy(profile),rounds=maxRounds??Math.max(2,pages+2);
  const sourceTokens=Math.ceil(characters*1.5),expectedRounds=Math.min(rounds,sourceTokens<=policy.inlineTokens?2:Math.ceil(Math.ceil(characters/policy.pageChars)/policy.readBatchSize)+3);
  const inputTokens=expectedRounds*Math.min(sourceTokens+6000,policy.inputTokens),outputTokens=expectedRounds*profile.maxOutputTokens;
  const cost = profile.prices ? (inputTokens * Math.max(profile.prices.input, profile.prices.cacheRead) + outputTokens * profile.prices.output) / 1e6 : null;
  return { inputTokens, outputTokens, rounds, expectedRounds, cost, currency: 'USD', pricingKnown: Boolean(profile.prices) };
}

export const modelConfigFingerprint=config=>digest(JSON.stringify([config.LLM_MODEL,config.LLM_API_URL,config.LLM_PROTOCOL,config.LLM_REASONING_EFFORT,config.LLM_MODEL_PROFILES||'',config.MEETING_TASK_BUDGET_USD||'',config.LLM_API_KEY]));

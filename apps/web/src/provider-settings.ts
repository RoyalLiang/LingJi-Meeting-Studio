import type {Bootstrap} from './model';
export const modelRoleLabels = [
  ['translation', '实时翻译'], ['intents', '会中重点'], ['minutesMap', '分段整理'],
  ['minutesFinal', '纪要终稿'], ['analysis', '跨会分析'],
] as const;

export function modelRoleValues(value = ''): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, model]) => typeof model === 'string'));
  } catch { return {}; }
}

export function updateModelRole(value: string | undefined, role: string, model: string) {
  const routes = modelRoleValues(value);
  if (model) routes[role] = model; else delete routes[role];
  return JSON.stringify(routes);
}

export function protocolForAddress(address: string) {
  return /\/chat\/completions\/?(?:\?|$)/.test(address.trim()) ? 'chat-completions' : 'responses';
}

export function minutesAvailable(providers: Bootstrap['providers'] | undefined, audioConsent=false){
  return Boolean(providers && (providers.minutes || !audioConsent && providers.minutesMode!=='doubao-audio-only' && providers.textMinutes));
}

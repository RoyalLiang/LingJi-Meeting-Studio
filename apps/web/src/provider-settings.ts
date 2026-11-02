import type {Bootstrap} from './model';
export function protocolForAddress(address: string) {
  return /\/chat\/completions\/?(?:\?|$)/.test(address.trim()) ? 'chat-completions' : 'responses';
}

export function minutesAvailable(providers: Bootstrap['providers'] | undefined, audioConsent=false){
  return Boolean(providers && (providers.minutes || !audioConsent && providers.minutesMode!=='doubao-audio-only' && providers.textMinutes));
}

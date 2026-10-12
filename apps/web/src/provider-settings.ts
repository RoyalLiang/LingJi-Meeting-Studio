export function protocolForAddress(address: string) {
  return /\/chat\/completions\/?(?:\?|$)/.test(address.trim()) ? 'chat-completions' : 'responses';
}

export function pcmBytes(pcm: string | Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return typeof pcm === 'string' ? Uint8Array.from(atob(pcm), char => char.charCodeAt(0)) : pcm;
}

export function pcmBase64(pcm: string | Uint8Array): string {
  if (typeof pcm === 'string') return pcm;
  let binary = '';
  for (let offset = 0; offset < pcm.length; offset += 8192) binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function pcmBytes(pcm: string | Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (typeof pcm !== 'string') return pcm;
  const binary = atob(pcm);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function pcmBase64(pcm: string | Uint8Array): string {
  if (typeof pcm === 'string') return pcm;
  let binary = '';
  for (let offset = 0; offset < pcm.length; offset += 8192) binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
  return btoa(binary);
}

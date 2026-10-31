import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function readBounded(url, limit) {
  const file = await open(url, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new Error('reading_pack_too_large');
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
export async function readRecognitionLexicon(directory) {
  try {
    const [bytes, metadata] = await Promise.all([readBounded(new URL('mandarin-readings.json', directory), 1000000), readBounded(new URL('mandarin-readings.manifest.json', directory), 8192)]);
    const manifest = JSON.parse(metadata.toString('utf8'));
    if (bytes.length > 1000000 || bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('invalid_reading_pack');
    const data = JSON.parse(bytes);
    if (data.language !== 'zh' || data.version !== manifest.version || Object.keys(data.readings).length !== manifest.characters || !Object.entries(data.readings).every(([char,sounds]) => Array.from(char).length === 1 && Array.isArray(sounds) && sounds.length <= 32 && sounds.every(sound => /^[a-z]{1,8}$/.test(sound)))) throw new Error('invalid_reading_pack');
    return { available: true, version: data.version, hash: manifest.sha256, readings: data.readings };
  } catch { return { available: false, version: null, hash: 'unavailable', readings: {} }; }
}
let loaded;
export function loadRecognitionLexicon() {
  return loaded ||= readRecognitionLexicon(new URL('../../../packages/records/src/data/', import.meta.url));
}

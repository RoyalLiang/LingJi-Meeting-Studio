export const MOBILE_PCM_BYTES = 32_000;
export const WAV_PCM_LIMIT = 0xffff_ffda;
export type PackedMobilePcm = { codec: 'pcm' | 'gzip'; length: number; bytes: Uint8Array<ArrayBuffer> };
export type PackedLocalMobilePcm = PackedMobilePcm | { codec: 'delta-gzip'; length: number; bytes: Uint8Array<ArrayBuffer> };

export async function packLocalMobilePcm(bytes: Uint8Array<ArrayBuffer>, wire: PackedMobilePcm): Promise<PackedLocalMobilePcm> {
  if (typeof CompressionStream === 'undefined' || bytes.length < 2048 || wire.bytes.length < 256) return wire;
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const differences = new Uint8Array(bytes.length);
  const target = new DataView(differences.buffer);
  let previous = 0;
  try {
    for (let i = 0; i < bytes.length; i += 2) {
      const sample = source.getUint16(i, true);
      target.setUint16(i, sample - previous, true);
      previous = sample;
    }
    const packed = await packMobilePcm(differences);
    if (packed.codec === 'gzip' && packed.bytes.length + 64 < wire.bytes.length) {
      return { ...packed, codec: 'delta-gzip' };
    }
    if (packed.bytes !== differences) packed.bytes.fill(0);
    return wire;
  } finally { differences.fill(0); }
}

export async function unpackLocalMobilePcm(packet: PackedLocalMobilePcm) {
  if (packet.codec !== 'delta-gzip') return unpackMobilePcm(packet);
  const bytes = await unpackMobilePcm({ ...packet, codec: 'gzip' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let previous = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    previous = (previous + view.getUint16(i, true)) & 0xffff;
    view.setUint16(i, previous, true);
  }
  return bytes;
}

export async function packMobilePcm(bytes: Uint8Array<ArrayBuffer>): Promise<PackedMobilePcm> {
  if (typeof CompressionStream !== 'undefined') {
    const compressed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    if (compressed.length < bytes.length) return { codec: 'gzip', length: bytes.length, bytes: compressed };
  }
  return { codec: 'pcm', length: bytes.length, bytes };
}

export async function unpackMobilePcm(packet: PackedMobilePcm) {
  const { codec, length, bytes } = packet;
  if (!Number.isInteger(length) || length <= 0 || length > MOBILE_PCM_BYTES || length % 2 ||
      !bytes.length || bytes.length > length || (codec !== 'gzip' && (codec !== 'pcm' || bytes.length !== length))) {
    throw new Error('录音片段格式无效');
  }
  if (codec === 'pcm') return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const result = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > length) throw new Error('录音片段超出标记大小');
      result.set(value, offset);
      offset += value.length;
    }
    if (offset !== length) throw new Error('录音片段长度不符');
    return result;
  } finally { await reader.cancel().catch(() => {}); }
}

export function wavHeader(size: number) {
  const bytes = new Uint8Array(44), view = new DataView(bytes.buffer), text = new TextEncoder();
  bytes.set(text.encode('RIFF'), 0);
  view.setUint32(4, size + 36, true);
  bytes.set(text.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, MOBILE_PCM_BYTES, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36);
  view.setUint32(40, size, true);
  return bytes;
}

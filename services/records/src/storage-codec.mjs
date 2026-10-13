import { createHash, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { DomainError } from '../../../packages/records/src/record.mjs';

const magic = Buffer.from('LJZ1');
const headerBytes = 41;
const maxBytes = 64 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest();

export function encodeStorage(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 1024 || bytes.length > maxBytes) return { bytes, compressed: false };
  const compressed = deflateRawSync(bytes, { level: 1 });
  if (compressed.length + headerBytes >= bytes.length) return { bytes, compressed: false };
  const header = Buffer.alloc(headerBytes);
  magic.copy(header); header[4] = 1; header.writeUInt32BE(bytes.length, 5); hash(bytes).copy(header, 9);
  return { bytes: Buffer.concat([header, compressed]), compressed: true };
}

export function decodeStorage(input, expectedHash) {
  const bytes = Buffer.from(input);
  if (expectedHash && hash(bytes).toString('hex') === expectedHash) return bytes;
  if (bytes.length < headerBytes || !bytes.subarray(0, 4).equals(magic) || bytes[4] !== 1) throw new DomainError('storage_corrupt', 500);
  const size = bytes.readUInt32BE(5);
  if (!size || size > maxBytes) throw new DomainError('storage_corrupt', 500);
  let decoded;
  try { decoded = inflateRawSync(bytes.subarray(headerBytes), { maxOutputLength: size }); }
  catch { throw new DomainError('storage_corrupt', 500); }
  const actual = hash(decoded);
  if (decoded.length !== size || !timingSafeEqual(actual, bytes.subarray(9, headerBytes)) || (expectedHash && actual.toString('hex') !== expectedHash)) throw new DomainError('storage_corrupt', 500);
  return decoded;
}

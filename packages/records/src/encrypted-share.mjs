import { normalizePublishedContent, ShareContentError } from './published-content.mjs';

export const MAX_ENCRYPTED_PLAINTEXT = 700 * 1024;
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
const fail = () => { throw new ShareContentError('invalid_encrypted_share', 400); };
export function encodeShareBytes(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value, max) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); } catch { fail(); }
  if (encodeShareBytes(bytes) !== value) fail();
  return bytes;
}
export function normalizeEncryptedEnvelope(input) {
  if (!input || input.version !== 1 || Object.keys(input).sort().join(',') !== 'ciphertext,iv,version') fail();
  if (decode(input.iv, 16).length !== 12) fail();
  const bytes = decode(input.ciphertext, Math.ceil((MAX_ENCRYPTED_PLAINTEXT + 16) * 4 / 3));
  if (bytes.length < 17 || bytes.length > MAX_ENCRYPTED_PLAINTEXT + 16) fail();
  return { version: 1, iv: input.iv, ciphertext: input.ciphertext };
}
function plaintext(input) {
  const content = normalizePublishedContent(input), bytes = encoder.encode(JSON.stringify(content));
  if (bytes.length > MAX_ENCRYPTED_PLAINTEXT) throw new ShareContentError('encrypted_share_too_large', 413);
  return bytes;
}
export async function shareFingerprint(input) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext(input))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function encryptShare(input) {
  const bytes = plaintext(input);
  const token = encodeShareBytes(crypto.getRandomValues(new Uint8Array(32)));
  const revokeToken = encodeShareBytes(crypto.getRandomValues(new Uint8Array(32)));
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`lingji-share-v1:${token}`) }, key, bytes);
  return { token, revokeToken, key: encodeShareBytes(keyBytes), envelope: { version: 1, iv: encodeShareBytes(iv), ciphertext: encodeShareBytes(new Uint8Array(ciphertext)) } };
}
export async function decryptShare(input, keyText, token) {
  const envelope = normalizeEncryptedEnvelope(input);
  if (!SHARE_TOKEN.test(token) || !SHARE_TOKEN.test(keyText)) fail();
  const keyBytes = decode(keyText, 43);
  if (keyBytes.length !== 32) fail();
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv, 16), additionalData: encoder.encode(`lingji-share-v1:${token}`) }, key, decode(envelope.ciphertext, 1000000));
    return normalizePublishedContent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
  } catch { throw new ShareContentError('share_decryption_failed', 400); }
}

export type Envelope = { nonce: string; body: string };
export type Vault = { id: string; salt: string; recovery: Envelope };
export type EncryptedOperation = Envelope & { id: string };

const encoder = new TextEncoder();
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const version = 'lingji-private-sync/1';

export function encodeBytes(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBytes(value: string) {
  if (!/^[\w-]+$/.test(value)) throw new Error('密文或恢复密钥格式有误');
  const data = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(data, character => character.charCodeAt(0));
}

async function key(material: Uint8Array<ArrayBuffer>, vault: Pick<Vault, 'salt'>, purpose: string) {
  if (material.byteLength < 32) throw new Error('密钥长度不正确');
  const input = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: decodeBytes(vault.salt), info: encoder.encode(version + '/' + purpose),
  }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(material: Uint8Array<ArrayBuffer>, vault: Pick<Vault, 'id' | 'salt'>, purpose: string, id: string, value: Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const nonce = random(12);
  const body = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(JSON.stringify([version, vault.id, purpose, id])),
  }, await key(material, vault, purpose), value);
  return { nonce: encodeBytes(nonce), body: encodeBytes(new Uint8Array(body)) };
}

export async function unseal(material: Uint8Array<ArrayBuffer>, vault: Pick<Vault, 'id' | 'salt'>, purpose: string, id: string, envelope: Envelope) {
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: decodeBytes(envelope.nonce), additionalData: encoder.encode(JSON.stringify([version, vault.id, purpose, id])),
  }, await key(material, vault, purpose), decodeBytes(envelope.body));
  return new Uint8Array(plain);
}

export async function createVault() {
  const root = random(32);
  const recoveryKey = random(32);
  const descriptor = { id: crypto.randomUUID(), salt: encodeBytes(random(32)) };
  const recovery = await seal(recoveryKey, descriptor, 'recovery', descriptor.id, root);
  const kit = 'LJ1.' + descriptor.id + '.' + encodeBytes(recoveryKey);
  recoveryKey.fill(0);
  return { root, vault: { ...descriptor, recovery }, kit };
}

export async function recoverVault(vault: Vault, kit: string) {
  const [prefix, id, secret, extra] = kit.trim().split('.');
  if (prefix !== 'LJ1' || id !== vault.id || secret?.length !== 43 || extra !== undefined) throw new Error('此恢复密钥不属于当前资料库');
  const recovery = decodeBytes(secret);
  try {
    return await unseal(recovery, vault, 'recovery', vault.id, vault.recovery);
  } finally {
    recovery.fill(0);
  }
}

export function newPairSecret() {
  return encodeBytes(random(32));
}

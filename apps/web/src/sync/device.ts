import type { Vault } from './vault';

export type DeviceVault = { vault: Vault; root: Uint8Array<ArrayBuffer>; kit?: string };
type StoredVault = { vault: Vault; key: CryptoKey; nonce: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };

const encode = new TextEncoder();
const decode = new TextDecoder('utf-8', { fatal: true });
const associatedData = (account: string, vault: Vault) =>
  encode.encode(JSON.stringify(['lingji-trusted-device/1', account, vault.id, vault.salt]));

let opening: Promise<IDBDatabase> | undefined;
function database() {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('lingji-trusted-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vaults');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}

export async function readDeviceVault(account: string, expected?: Vault): Promise<DeviceVault | null> {
  const db = await database();
  const saved = await new Promise<StoredVault | undefined>((resolve, reject) => {
    const request = db.transaction('vaults').objectStore('vaults').get(account);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!saved || (expected && (saved.vault.id !== expected.id || saved.vault.salt !== expected.salt))) return null;
  const bytes = new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: saved.nonce, additionalData: associatedData(account, saved.vault),
  }, saved.key, saved.ciphertext));
  try {
    if (bytes.length < 32) throw new Error('本机同步密钥无效');
    return { vault: saved.vault, root: bytes.slice(0, 32), kit: decode.decode(bytes.subarray(32)) || undefined };
  } finally { bytes.fill(0); }
}

export async function rememberDeviceVault(account: string, draft: DeviceVault, onlyIfAbsent = false) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const backup = encode.encode(draft.kit ?? '');
  const bytes = new Uint8Array(draft.root.length + backup.length);
  bytes.set(draft.root);
  bytes.set(backup, draft.root.length);
  backup.fill(0);
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv: nonce, additionalData: associatedData(account, draft.vault),
    }, key, bytes);
  } finally { bytes.fill(0); }
  const db = await database();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction('vaults', 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => {
      if (onlyIfAbsent && tx.error?.name === 'ConstraintError') resolve(false);
      else reject(tx.error ?? new Error('本机同步密钥保存失败'));
    };
    const store = tx.objectStore('vaults');
    const record = { vault: draft.vault, key, nonce, ciphertext } satisfies StoredVault;
    if (onlyIfAbsent) store.add(record, account);
    else store.put(record, account);
  });
}

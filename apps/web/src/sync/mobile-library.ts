import { seal, sealBinary, unseal, unsealBinary, type BinaryEnvelope, type EncryptedOperation, type Envelope, type Vault } from './vault';

export type MobileRecording = {
  id: string;
  title: string;
  at: number;
  seconds: number;
  marks: number[];
};

const MAX_LOCAL_RECORDINGS = 20;
const MAX_LOCAL_BYTES = 120 * 1024 * 1024;
const metadataCache = new Map<string, MobileRecording[]>();

export function clearMobileLibraryCache(vaultId?: string) {
  if (vaultId) metadataCache.delete(vaultId);
  else metadataCache.clear();
}

function request<T>(value: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

let opening: Promise<IDBDatabase> | undefined;
function database() {
  if (!opening) {
    const db = indexedDB.open('lingji-mobile-library', 1);
    db.onupgradeneeded = () => {
      db.result.createObjectStore('recordings');
      db.result.createObjectStore('audio');
    };
    opening = request(db).then(value => {
      value.onversionchange = () => { value.close(); opening = undefined; };
      return value;
    }, error => { opening = undefined; throw error; });
  }
  return opening;
}

export async function rememberMobileRecording(vault: Vault, root: Uint8Array<ArrayBuffer>, entry: MobileRecording, audio: Blob) {
  const pcm = new Uint8Array(await audio.arrayBuffer());
  try {
    const [metadata, media] = await Promise.all([
      seal(root, vault, 'phone-recording/1', entry.id, new TextEncoder().encode(JSON.stringify(entry))),
      sealBinary(root, vault, 'phone-wav/1', entry.id, pcm),
    ]);
    const existing = await mobileRecordings(vault, root).catch(() => [] as MobileRecording[]);
    const nextList = [entry, ...existing.filter(item => item.id !== entry.id)].sort((a, b) => b.at - a.at);
    const keepIds = new Set<string>();
    let totalBytes = 0;
    for (const item of nextList) {
      const approxBytes = Math.max(32000, item.seconds * 32000);
      if (keepIds.size > 0 && (keepIds.size >= MAX_LOCAL_RECORDINGS || totalBytes + approxBytes > MAX_LOCAL_BYTES)) continue;
      keepIds.add(item.id);
      totalBytes += approxBytes;
    }
    const evictIds = existing.filter(item => !keepIds.has(item.id)).map(item => item.id);
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['recordings', 'audio'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('手机回听未保存'));
      const recordingsStore = tx.objectStore('recordings');
      const audioStore = tx.objectStore('audio');
      for (const oldId of evictIds) {
        recordingsStore.delete([vault.id, oldId]);
        audioStore.delete([vault.id, oldId]);
      }
      recordingsStore.put({ id: entry.id, ...metadata }, [vault.id, entry.id]);
      audioStore.put(media, [vault.id, entry.id]);
    });
    metadataCache.set(vault.id, nextList.filter(item => keepIds.has(item.id)));
  } finally { pcm.fill(0); }
}

export async function deleteMobileRecording(vault: Vault, id: string) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['recordings', 'audio'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('无法删除本机录音'));
    tx.objectStore('recordings').delete([vault.id, id]);
    tx.objectStore('audio').delete([vault.id, id]);
  });
  const cached = metadataCache.get(vault.id);
  if (cached) metadataCache.set(vault.id, cached.filter(item => item.id !== id));
}

export async function mobileRecordings(vault: Vault, root: Uint8Array<ArrayBuffer>) {
  const cached = metadataCache.get(vault.id);
  if (cached) return cached;
  const db = await database();
  const range = IDBKeyRange.bound([vault.id], [vault.id, []]);
  const entries = await request<EncryptedOperation[]>(db.transaction('recordings').objectStore('recordings').getAll(range));
  const list = (await Promise.all(entries.map(async entry => {
    const bytes = await unseal(root, vault, 'phone-recording/1', entry.id, entry);
    try { return JSON.parse(new TextDecoder().decode(bytes)) as MobileRecording; }
    finally { bytes.fill(0); }
  }))).sort((a, b) => b.at - a.at);
  metadataCache.set(vault.id, list);
  return list;
}

export async function mobilePlayback(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string) {
  const db = await database();
  const operation = await request<Envelope | BinaryEnvelope | undefined>(db.transaction('audio').objectStore('audio').get([vault.id, id]));
  if (!operation) return null;
  const bytes = await unsealBinary(root, vault, 'phone-wav/1', id, operation);
  try { return new Blob([bytes], { type: 'audio/wav' }); }
  finally { bytes.fill(0); }
}

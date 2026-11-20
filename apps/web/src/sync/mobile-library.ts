import { seal, unseal, type EncryptedOperation, type Vault } from './vault';

export type MobileRecording = {
  id: string;
  title: string;
  at: number;
  seconds: number;
  marks: number[];
};

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
      seal(root, vault, 'phone-wav/1', entry.id, pcm)
    ]);
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['recordings', 'audio'], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('手机回听未保存'));
      tx.objectStore('recordings').put({ id: entry.id, ...metadata }, [vault.id, entry.id]);
      tx.objectStore('audio').put(media, [vault.id, entry.id]);
    });
  } finally { pcm.fill(0); }
}

export async function mobileRecordings(vault: Vault, root: Uint8Array<ArrayBuffer>) {
  const db = await database();
  const range = IDBKeyRange.bound([vault.id], [vault.id, []]);
  const entries = await request<EncryptedOperation[]>(db.transaction('recordings').objectStore('recordings').getAll(range));
  return (await Promise.all(entries.map(async entry => {
    const bytes = await unseal(root, vault, 'phone-recording/1', entry.id, entry);
    try { return JSON.parse(new TextDecoder().decode(bytes)) as MobileRecording; }
    finally { bytes.fill(0); }
  }))).sort((a, b) => b.at - a.at);
}

export async function mobilePlayback(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string) {
  const db = await database();
  const operation = await request<EncryptedOperation | undefined>(db.transaction('audio').objectStore('audio').get([vault.id, id]));
  if (!operation) return null;
  const bytes = await unseal(root, vault, 'phone-wav/1', id, operation);
  try { return new Blob([bytes], { type: 'audio/wav' }); }
  finally { bytes.fill(0); }
}

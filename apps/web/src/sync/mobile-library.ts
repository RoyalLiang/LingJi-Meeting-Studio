import { seal, sealBinary, unseal, unsealBinary, type BinaryEnvelope, type EncryptedOperation, type Envelope, type Vault } from './vault';
import { unpackLocalMobilePcm, wavHeader, WAV_PCM_LIMIT, type PackedLocalMobilePcm } from './mobile-pcm';

export type MobileRecording = {
  id: string;
  title: string;
  at: number;
  seconds: number;
  marks: number[]; directReady?: true;
};

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

async function writeRecording(vault: Vault, root: Uint8Array<ArrayBuffer>, entry: MobileRecording, sequence?: number, chunk?: BinaryEnvelope) {
  const metadata = sequence === undefined || sequence % 16 === 0
    ? await seal(root, vault, 'phone-recording/1', entry.id, new TextEncoder().encode(JSON.stringify(entry))) : null;
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['recordings', 'audio'], 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('手机回听未保存'));
    if (metadata) tx.objectStore('recordings').put({ id: entry.id, ...metadata }, [vault.id, entry.id]);
    if (chunk && sequence !== undefined) tx.objectStore('audio').put(chunk, [vault.id, entry.id, sequence]);
  });
  if (metadata) clearMobileLibraryCache(vault.id);
}

export async function appendMobileRecording(vault: Vault, root: Uint8Array<ArrayBuffer>, entry: MobileRecording, sequence: number, pcm: PackedLocalMobilePcm) {
  const bytes = new Uint8Array(3 + pcm.bytes.length);
  bytes[0] = pcm.codec === 'delta-gzip' ? 2 : pcm.codec === 'gzip' ? 1 : 0;
  new DataView(bytes.buffer).setUint16(1, pcm.length);
  bytes.set(pcm.bytes, 3);
  let chunk;
  try { chunk = await sealBinary(root, vault, 'phone-pcm/2', entry.id + ':' + sequence, bytes); }
  finally { bytes.fill(0); }
  await writeRecording(vault, root, entry, sequence, chunk);
}

export async function finishMobileRecording(vault: Vault, root: Uint8Array<ArrayBuffer>, entry: MobileRecording) {
  await writeRecording(vault, root, entry);
}

export async function deleteMobileRecording(vault: Vault, id: string) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['recordings', 'audio'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('无法删除本机录音'));
    tx.objectStore('recordings').delete([vault.id, id]);
    const audio = tx.objectStore('audio');
    audio.delete(IDBKeyRange.bound([vault.id, id], [vault.id, id, []]));
    audio.put(true, ['hidden', vault.id, id]);
  });
  const cached = metadataCache.get(vault.id);
  if (cached) metadataCache.set(vault.id, cached.filter(item => item.id !== id));
}

export async function hiddenMobileRecordings(vault: Vault) {
  const db = await database();
  const keys = await request(db.transaction('audio').objectStore('audio').getAllKeys(
    IDBKeyRange.bound(['hidden', vault.id], ['hidden', vault.id, []])
  ));
  return new Set(keys.map(key => (key as string[])[2]));
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
  if (operation) {
    const bytes = await unsealBinary(root, vault, 'phone-wav/1', id, operation);
    try { return new Blob([bytes], { type: 'audio/wav' }); }
    finally { bytes.fill(0); }
  }
  const pieces: Blob[] = [];
  let size = 0;
  for (;;) {
    const snapshot = db.transaction('audio').objectStore('audio');
    const range = IDBKeyRange.bound([vault.id, id, pieces.length], [vault.id, id, []]);
    const [keys, chunks] = await Promise.all([request(snapshot.getAllKeys(range, 16)), request<BinaryEnvelope[]>(snapshot.getAll(range, 16))]);
    if (!chunks.length) break;
    for (let index = 0; index < chunks.length; index++) {
      const sequence = (keys[index] as [string, string, number])[2];
      if (sequence !== pieces.length) throw new Error('手机录音片段不连续');
      const packet = await unsealBinary(root, vault, 'phone-pcm/2', id + ':' + sequence, chunks[index]);
      try {
        if (packet.length < 4 || packet[0] > 2) throw new Error('手机录音片段无效');
        const length = new DataView(packet.buffer, packet.byteOffset).getUint16(1);
        const pcm = await unpackLocalMobilePcm({ codec: packet[0] === 2 ? 'delta-gzip' : packet[0] ? 'gzip' : 'pcm', length, bytes: packet.subarray(3) });
        try {
          size += pcm.length;
          if (size > WAV_PCM_LIMIT) throw new Error('录音超过 WAV 格式容量');
          pieces.push(new Blob([pcm]));
        } finally { pcm.fill(0); }
      } finally { packet.fill(0); }
    }
  }
  return pieces.length ? new Blob([wavHeader(size), ...pieces], { type: 'audio/wav' }) : null;
}

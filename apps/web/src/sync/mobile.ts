import { api } from '../api';
import { decodeBytes, encodeBytes, seal, unseal, type EncryptedOperation, type Vault } from './vault';

const PART = 100 * 1024;
export const MOBILE_AUDIO_LIMIT = 12 * 1024 * 1024;
const MAX_PARTS = Math.ceil(MOBILE_AUDIO_LIMIT / PART);
const purpose = 'mobile-audio/1';
const endpoint = '/private-sync/audio';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type Recording = { id: string; title: string; mime: string; total: number };
type AudioPart = Recording & { index: number; data: string };
type Outbox = { id: string; operations: EncryptedOperation[]; next: number };
type Delta = { cursor: number; more: boolean; operations: (EncryptedOperation & { seq: number })[] };

let opening: Promise<IDBDatabase> | undefined;
function request<T>(operation: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function database() {
  if (opening) return opening;
  const open = indexedDB.open('lingji-mobile-audio', 1);
  open.onupgradeneeded = () => {
    for (const name of ['outbox', 'inbox', 'parts', 'cursor']) open.result.createObjectStore(name);
  };
  opening = request(open).then(db => {
    db.onversionchange = () => { db.close(); opening = undefined; };
    return db;
  }, error => { opening = undefined; throw error; });
  return opening;
}
async function change(stores: string[], run: (tx: IDBTransaction) => void) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('录音无法保存在本机'));
    run(tx);
  });
}
const group = (vault: Vault, id: string) => [vault.id, id];
const groups = (vault: Vault) => IDBKeyRange.bound([vault.id, ''], [vault.id, '\uffff']);
const parts = (vault: Vault, id: string) => IDBKeyRange.bound([vault.id, id, 0], [vault.id, id, MAX_PARTS]);
const mimePattern = /^(?:audio|video)\/(?:webm|mp4|ogg|wav|x-wav)(?:;.*)?$/i;

async function decode(operation: EncryptedOperation, vault: Vault, root: Uint8Array<ArrayBuffer>): Promise<AudioPart> {
  const plain = await unseal(root, vault, purpose, operation.id, operation);
  const value = JSON.parse(decoder.decode(plain));
  if (!uuid.test(value?.id) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 ||
      typeof value.mime !== 'string' || value.mime.length > 100 || !mimePattern.test(value.mime) ||
      !Number.isSafeInteger(value.total) || value.total < 1 || value.total > MAX_PARTS ||
      !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= value.total ||
      typeof value.data !== 'string' || value.data.length > Math.ceil(PART * 4 / 3)) {
    throw new Error('收到无效的手机录音片段');
  }
  return value;
}

export async function queueMobileRecording(vault: Vault, root: Uint8Array<ArrayBuffer>, blob: Blob, title: string) {
  if (!blob.size || blob.size > MOBILE_AUDIO_LIMIT || !mimePattern.test(blob.type)) throw new Error('录音格式或大小不支持');
  const recording = { id: crypto.randomUUID(), title: title.trim().slice(0, 160) || '手机录音', mime: blob.type, total: Math.ceil(blob.size / PART) };
  const operations: EncryptedOperation[] = [];
  for (let index = 0; index < recording.total; index++) {
    const bytes = new Uint8Array(await blob.slice(index * PART, (index + 1) * PART).arrayBuffer());
    const id = crypto.randomUUID();
    operations.push({ id, ...await seal(root, vault, purpose, id, encoder.encode(JSON.stringify({ ...recording, index, data: encodeBytes(bytes) }))) });
    bytes.fill(0);
  }
  await change(['outbox'], tx => tx.objectStore('outbox').add({ id: recording.id, operations, next: 0 } satisfies Outbox, group(vault, recording.id)));
}

export async function pushMobileRecordings(vault: Vault, signal: AbortSignal) {
  const db = await database();
  const outbox = await request<Outbox[]>(db.transaction('outbox').objectStore('outbox').getAll(groups(vault), 1));
  const recording = outbox[0];
  if (!recording) return { sent: false, pending: 0 };
  const key = group(vault, recording.id);
  let next = recording.next;
  for (let batch = 0; batch < 12 && next < recording.operations.length; batch++) {
    signal.throwIfAborted();
    const operations = recording.operations.slice(next, next + 2);
    const { acknowledgements } = await api<{ acknowledgements: { id: string; seq: number }[] }>(endpoint, 'POST', { vault: vault.id, operations }, signal);
    if (acknowledgements.length !== operations.length || acknowledgements.some((ack, index) => ack.id !== operations[index].id || !Number.isSafeInteger(ack.seq) || ack.seq <= 0)) {
      throw new Error('录音同步确认无效');
    }
    next += operations.length;
    const received = next;
    await change(['outbox'], tx => {
      const store = tx.objectStore('outbox');
      const get = store.get(key);
      get.onsuccess = () => {
        if (!get.result || get.result.next >= received) return;
        if (received === recording.operations.length) store.delete(key);
        else store.put({ ...recording, next: received }, key);
      };
    });
  }
  return { sent: next === recording.operations.length, pending: await request(db.transaction('outbox').objectStore('outbox').count(groups(vault))) };
}

export async function receiveMobileRecordings(vault: Vault, root: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  const db = await database();
  for (let page = 0; page < 8; page++) {
    const after = await request<number | undefined>(db.transaction('cursor').objectStore('cursor').get(vault.id)) ?? 0;
    const batch = await api<Delta>(endpoint + '?vault=' + vault.id + '&after=' + after, 'GET', undefined, signal);
    let cursor = after;
    const verified: { operation: EncryptedOperation; part: AudioPart }[] = [];
    for (const { seq, ...operation } of batch.operations) {
      if (seq !== ++cursor || !uuid.test(operation.id)) throw new Error('录音同步游标不连续');
      verified.push({ operation, part: await decode(operation, vault, root) });
    }
    if (cursor !== batch.cursor || (cursor === after && batch.more)) throw new Error('录音同步游标无效');
    if (verified.length) await change(['cursor', 'inbox', 'parts'], tx => {
      const cursors = tx.objectStore('cursor');
      const saved = cursors.get(vault.id);
      saved.onsuccess = () => {
        if ((saved.result ?? 0) >= cursor) return;
        const inbox = tx.objectStore('inbox'), pieces = tx.objectStore('parts');
        for (const { operation, part: { id, title, mime, total, index } } of verified) {
          pieces.put(operation, [...group(vault, id), index]);
          if (index === total - 1) inbox.put({ id, title, mime, total } satisfies Recording, group(vault, id));
        }
        cursors.put(cursor, vault.id);
      };
    });
    if (!batch.more) break;
  }
}

export async function nextMobileRecording(vault: Vault, root: Uint8Array<ArrayBuffer>) {
  const db = await database();
  const recordings = await request<Recording[]>(db.transaction('inbox').objectStore('inbox').getAll(groups(vault), 1));
  const recording = recordings[0];
  if (!recording) return null;
  const operations = await request<EncryptedOperation[]>(db.transaction('parts').objectStore('parts').getAll(parts(vault, recording.id), MAX_PARTS));
  if (operations.length !== recording.total) throw new Error('手机录音片段不完整');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const operation of operations) {
    const part = await decode(operation, vault, root);
    if (part.id !== recording.id || part.index !== chunks.length || part.total !== recording.total || part.mime !== recording.mime) {
      throw new Error('手机录音片段校验失败');
    }
    chunks.push(decodeBytes(part.data));
  }
  const extension = recording.mime.includes('mp4') ? 'm4a' : recording.mime.includes('wav') ? 'wav' : recording.mime.includes('ogg') ? 'ogg' : 'webm';
  const file = new File(chunks, recording.id + '.' + extension, { type: recording.mime });
  if (file.size > MOBILE_AUDIO_LIMIT) throw new Error('手机录音超过大小上限');
  return { ...recording, file };
}

export async function acknowledgeMobileRecording(vault: Vault, id: string) {
  await change(['inbox', 'parts'], tx => {
    tx.objectStore('inbox').delete(group(vault, id));
    tx.objectStore('parts').delete(parts(vault, id));
  });
}

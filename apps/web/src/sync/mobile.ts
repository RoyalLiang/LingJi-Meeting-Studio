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
type Delta = { cursor: number; more: boolean; trimmed?: boolean; operations: (EncryptedOperation & { seq: number })[] };
const pendingDesktopReceipts = new Set<string>();

let opening: Promise<IDBDatabase> | undefined;
function request<T>(operation: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function database() {
  if (opening) return opening;
  const open = indexedDB.open('lingji-mobile-audio', 2);
  open.onupgradeneeded = () => {
    for (const name of ['outbox', 'inbox', 'parts', 'cursor', 'live-outbox', 'live-cursor']) {
      if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    }
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

export async function queueMobileRecording(vault: Vault, root: Uint8Array<ArrayBuffer>, blob: Blob, title: string, id: string = crypto.randomUUID()) {
  if (!blob.size || blob.size > MOBILE_AUDIO_LIMIT || !mimePattern.test(blob.type)) throw new Error('录音格式或大小不支持');
  const recording = { id, title: title.trim().slice(0, 160) || '手机录音', mime: blob.type, total: Math.ceil(blob.size / PART) };
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
  const progressKey = [...key, 'outbox-progress'];
  const stored = await request<number | undefined>(db.transaction('cursor').objectStore('cursor').get(progressKey));
  let next = Math.max(recording.next, stored ?? 0);
  for (let batch = 0; batch < 12 && next < recording.operations.length; batch++) {
    signal.throwIfAborted();
    const operations = recording.operations.slice(next, next + 2);
    const { acknowledgements } = await api<{ acknowledgements: { id: string; seq: number }[] }>(endpoint, 'POST', { vault: vault.id, operations }, signal);
    if (acknowledgements.length !== operations.length || acknowledgements.some((ack, index) => ack.id !== operations[index].id || !Number.isSafeInteger(ack.seq) || ack.seq <= 0)) {
      throw new Error('录音同步确认无效');
    }
    next += operations.length;
    const received = next;
    await change(['outbox', 'cursor'], tx => {
      const store = tx.objectStore('outbox'), progress = tx.objectStore('cursor');
      const queued = store.getKey(key);
      queued.onsuccess = () => {
        if (queued.result === undefined) return;
        if (next === recording.operations.length) {
          store.delete(key);
          progress.delete(progressKey);
        } else {
          const prior = progress.get(progressKey);
          prior.onsuccess = () => {
            if ((prior.result ?? 0) < next) progress.put(next, progressKey);
          };
        }
      };
    });
  }
  return { sent: next === recording.operations.length, pending: await request(db.transaction('outbox').objectStore('outbox').count(groups(vault))) };
}

async function pruneRemoteStream(path: string, vault: Vault, before: number, signal?: AbortSignal) {
  if (before <= 0) return;
  try {
    await api(`${path}?vault=${encodeURIComponent(vault.id)}&before=${before}`, 'DELETE', undefined, signal);
  } catch { /* Quota pruning is best-effort after durable desktop ingestion. */ }
}

export async function receiveMobileRecordings(vault: Vault, root: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  const db = await database();
  for (let page = 0; page < 8; page++) {
    const after = await request<number | undefined>(db.transaction('cursor').objectStore('cursor').get(vault.id)) ?? 0;
    const batch = await api<Delta>(endpoint + '?vault=' + vault.id + '&after=' + after, 'GET', undefined, signal);
    let cursor = after;
    const verified: { operation: EncryptedOperation; part: AudioPart }[] = [];
    for (let i = 0; i < batch.operations.length; i++) {
      const { seq, ...operation } = batch.operations[i];
      const allowedJump = i === 0 && batch.trimmed && seq > cursor;
      if ((!allowedJump && seq !== ++cursor) || !uuid.test(operation.id)) throw new Error('录音同步游标不连续');
      cursor = seq;
      verified.push({ operation, part: await decode(operation, vault, root) });
    }
    if (!batch.operations.length && batch.trimmed && batch.cursor > cursor) cursor = batch.cursor;
    if (cursor !== batch.cursor || (cursor === after && batch.more)) throw new Error('录音同步游标无效');
    if (verified.length || cursor > after) await change(['cursor', 'inbox', 'parts'], tx => {
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

export async function acknowledgeMobileRecording(vault: Vault, id: string, signal?: AbortSignal) {
  await change(['inbox', 'parts'], tx => {
    tx.objectStore('inbox').delete(group(vault, id));
    tx.objectStore('parts').delete(parts(vault, id));
  });
  const db = await database();
  const remaining = await request(db.transaction('inbox').objectStore('inbox').count(groups(vault)));
  if (remaining === 0) {
    const cursor = await request<number | undefined>(db.transaction('cursor').objectStore('cursor').get(vault.id)) ?? 0;
    await pruneRemoteStream(endpoint, vault, cursor, signal);
  }
}

const livePurpose = 'mobile-live-audio/1';
const liveEndpoint = '/private-sync/live-audio';
const receiptEndpoint = '/private-sync/live-receipts';
export const MOBILE_RECORDING_BYTES = 5 * 60 * 32000;
export type MobileFrame =
  | { kind: 'pcm'; sequence: number; offset: number; data: string }
  | { kind: 'finish'; sequence: number };
type LiveFrame = { id: string; title: string } & (MobileFrame | { kind: 'received' });

async function sealFrame(vault: Vault, root: Uint8Array<ArrayBuffer>, frame: LiveFrame) {
  const id = crypto.randomUUID();
  const bytes = encoder.encode(JSON.stringify(frame));
  try { return { id, ...await seal(root, vault, livePurpose, id, bytes) }; }
  finally { bytes.fill(0); }
}

export async function queueLiveAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string, title: string, frame: MobileFrame) {
  const operation = await sealFrame(vault, root, { ...frame, id, title });
  await change(['live-outbox'], tx => tx.objectStore('live-outbox').add(operation, [vault.id, 'phone', id, frame.sequence]));
}

async function pushLive(path: string, vault: Vault, operations: EncryptedOperation[], signal: AbortSignal) {
  const { acknowledgements } = await api<{ acknowledgements: { id: string; seq: number }[] }>(
    path, 'POST', { vault: vault.id, operations }, signal
  );
  if (acknowledgements.length !== operations.length || acknowledgements.some((ack, i) =>
    ack.id !== operations[i].id || !Number.isSafeInteger(ack.seq) || ack.seq <= 0
  )) throw new Error('实时录音同步回执无效');
}

export async function pushLiveAudio(vault: Vault, receiver: 'phone' | 'desktop', signal: AbortSignal, force = false) {
  if (receiver === 'desktop' && !force && !pendingDesktopReceipts.has(vault.id)) return [];
  const db = await database();
  const store = db.transaction('live-outbox').objectStore('live-outbox');
  const range = IDBKeyRange.bound([vault.id, receiver], [vault.id, receiver, []]);
  const [keys, operations] = await Promise.all([
    request(store.getAllKeys(range, 8)),
    request<EncryptedOperation[]>(store.getAll(range, 8))
  ]);
  if (!operations.length) {
    if (receiver === 'desktop') pendingDesktopReceipts.delete(vault.id);
    return [];
  }
  await pushLive(receiver === 'phone' ? liveEndpoint : receiptEndpoint, vault, operations, signal);
  await change(['live-outbox'], tx => {
    for (const key of keys) tx.objectStore('live-outbox').delete(key);
  });
  if (receiver === 'desktop' && operations.length < 8) pendingDesktopReceipts.delete(vault.id);
  return keys;
}

export async function acknowledgeLiveAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string, title: string) {
  const operation = await sealFrame(vault, root, { kind: 'received', id, title });
  await change(['live-outbox'], tx => {
    const store = tx.objectStore('live-outbox');
    const key = [vault.id, 'desktop', id];
    const pending = store.getKey(key);
    pending.onsuccess = () => { if (pending.result === undefined) store.add(operation, key); };
  });
  pendingDesktopReceipts.add(vault.id);
}

function decodeLiveFrame(plain: Uint8Array): LiveFrame {
  const frame: LiveFrame = JSON.parse(decoder.decode(plain));
  if (!uuid.test(frame?.id) || typeof frame.title !== 'string' || !frame.title.trim() || frame.title.length > 160) {
    throw new Error('实时录音标识无效');
  }
  if (frame.kind === 'received') return frame;
  if (!('sequence' in frame) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
      frame.sequence >= 1000000) throw new Error('实时录音序号无效');
  if (frame.kind === 'finish' && frame.sequence > 0) return frame;
  if (frame.kind === 'pcm' && Number.isSafeInteger(frame.offset) && frame.offset >= 0 &&
      frame.offset < MOBILE_RECORDING_BYTES / 2 && typeof frame.data === 'string' &&
      frame.data.length > 0 && frame.data.length <= Math.ceil(32000 * 4 / 3)) return frame;
  throw new Error('实时录音片段无效');
}

export async function pullLiveAudio(
  vault: Vault, root: Uint8Array<ArrayBuffer>, receiver: 'phone' | 'desktop', signal: AbortSignal,
  consume: (frame: LiveFrame) => void | Promise<void>
) {
  const db = await database();
  const key = [vault.id, receiver];
  const path = receiver === 'phone' ? receiptEndpoint : liveEndpoint;
  const after = await request<number | undefined>(db.transaction('live-cursor').objectStore('live-cursor').get(key)) ?? 0;
  const delta = await api<Delta>(path + '?vault=' + encodeURIComponent(vault.id) + '&after=' + after, 'GET', undefined, signal);
  let cursor = after;
  for (let i = 0; i < delta.operations.length; i++) {
    const { seq, ...operation } = delta.operations[i];
    signal.throwIfAborted();
    const allowedJump = i === 0 && delta.trimmed && seq > cursor;
    if ((!allowedJump && seq !== ++cursor) || !uuid.test(operation.id)) throw new Error('实时录音同步游标不连续');
    cursor = seq;
    const plain = await unseal(root, vault, livePurpose, operation.id, operation);
    let frame: LiveFrame;
    try { frame = decodeLiveFrame(plain); }
    finally { plain.fill(0); }
    if ((frame.kind === 'received') !== (receiver === 'phone')) throw new Error('实时录音事件类型无效');
    await consume(frame);
  }
  if (!delta.operations.length && delta.trimmed && delta.cursor > cursor) cursor = delta.cursor;
  if (cursor !== delta.cursor || (cursor === after && delta.more)) throw new Error('实时录音同步游标无效');
  if (cursor === after) return false;
  await change(['live-cursor'], tx => {
    const store = tx.objectStore('live-cursor');
    const saved = store.get(key);
    saved.onsuccess = () => {
      if (cursor > (saved.result ?? 0)) store.put(cursor, key);
    };
  });
  if (receiver === 'desktop' && delta.operations.length > 0) {
    await pruneRemoteStream(liveEndpoint, vault, cursor, signal);
  }
  return delta.more;
}

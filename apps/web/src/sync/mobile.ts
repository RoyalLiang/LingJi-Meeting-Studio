import { api } from '../api';
import { decodeBytes, encodeBytes, seal, unseal, type EncryptedOperation, type Vault } from './vault';
import { MOBILE_PCM_BYTES, unpackMobilePcm, WAV_PCM_LIMIT, type PackedMobilePcm } from './mobile-pcm';

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
type Delta = { cursor: number; more: boolean; trimmed?: boolean; acknowledged?: number; operations: (EncryptedOperation & { seq: number })[] };
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

async function acknowledgeRemoteAudio(path: string, vault: Vault, cursor: number, acknowledged: number | undefined, signal: AbortSignal) {
  // Older servers delete immediately, so only acknowledge when deferred reclamation is advertised.
  if (acknowledged === undefined || !Number.isSafeInteger(acknowledged) || acknowledged < 0 || cursor <= acknowledged) return;
  await api(`${path}?vault=${encodeURIComponent(vault.id)}&before=${cursor}`, 'DELETE', undefined, signal);
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
      if (!Number.isSafeInteger(seq) || (!allowedJump && seq !== cursor + 1) || !uuid.test(operation.id)) throw new Error('录音同步游标不连续');
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
          if (index === total - 1) {
            const available = pieces.count(parts(vault, id));
            available.onsuccess = () => {
              if (available.result === total) inbox.put({ id, title, mime, total } satisfies Recording, group(vault, id));
            };
          }
        }
        cursors.put(cursor, vault.id);
      };
    });
    if (!batch.more) {
      const snapshot = db.transaction(['cursor', 'parts'], 'readonly');
      const [saved, remaining] = await Promise.all([
        request<number | undefined>(snapshot.objectStore('cursor').get(vault.id)),
        request(snapshot.objectStore('parts').count(IDBKeyRange.bound([vault.id], [vault.id, []]))),
      ]);
      if (remaining === 0) await acknowledgeRemoteAudio(endpoint, vault, Math.min(saved ?? 0, cursor), batch.acknowledged, signal);
      break;
    }
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

const livePurpose = 'mobile-live-audio/1';
const liveEndpoint = '/private-sync/live-audio';
const liveV2Purpose = 'mobile-live-audio/2';
const liveV2Endpoint = '/private-sync/live-audio-v2';
const receiptEndpoint = '/private-sync/live-receipts';
const liveGapRetry = new WeakMap<Vault, Map<string, number>>();
export type MobileFrame =
  | { kind: 'pcm'; sequence: number; offset: number; pcm: PackedMobilePcm; recordedAt?: number }
  | { kind: 'finish'; sequence: number };
export type LiveFrame = { id: string; title: string } & (MobileFrame | { kind: 'received'; complete?: true });

type LegacyPcmFrame = { id: string; title: string; kind: 'pcm'; sequence: number; offset: number; data: string; recordedAt?: number };
async function sealFrame(vault: Vault, root: Uint8Array<ArrayBuffer>, frame: LiveFrame | LegacyPcmFrame) {
  const id = crypto.randomUUID();
  const bytes = encoder.encode(JSON.stringify(frame));
  try { return { id, ...await seal(root, vault, livePurpose, id, bytes) }; }
  finally { bytes.fill(0); }
}

async function storeLiveFrame(key: IDBValidKey, operation: EncryptedOperation) {
  await change(['live-outbox'], tx => {
    const store = tx.objectStore('live-outbox');
    const prior = store.getKey(key);
    prior.onsuccess = () => { if (prior.result === undefined) store.add(operation, key); };
  });
}

export async function queueLiveAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string, title: string, frame: MobileFrame, legacy = false, hold = false) {
  if (legacy) {
    let operation;
    if (frame.kind === 'pcm') {
      const bytes = await unpackMobilePcm(frame.pcm);
      try {
        operation = await sealFrame(vault, root, {
          id, title, kind: 'pcm', sequence: frame.sequence, offset: frame.offset, data: encodeBytes(bytes), recordedAt: frame.recordedAt,
        });
      } finally { if (bytes !== frame.pcm.bytes) bytes.fill(0); }
    } else operation = await sealFrame(vault, root, { ...frame, id, title });
    await storeLiveFrame([vault.id, hold ? 'held-phone' : 'phone', id, frame.sequence], operation);
    return;
  }
  const metadata = frame.kind === 'pcm'
    ? { id, title, kind: frame.kind, sequence: frame.sequence, offset: frame.offset, codec: frame.pcm.codec, length: frame.pcm.length, recordedAt: frame.recordedAt }
    : { ...frame, id, title };
  const header = encoder.encode(JSON.stringify(metadata) + '\n');
  const bytes = new Uint8Array(header.length + (frame.kind === 'pcm' ? frame.pcm.bytes.length : 0));
  bytes.set(header);
  if (frame.kind === 'pcm') bytes.set(frame.pcm.bytes, header.length);
  const operationId = crypto.randomUUID();
  let operation: EncryptedOperation;
  try { operation = { id: operationId, ...await seal(root, vault, liveV2Purpose, operationId, bytes) }; }
  finally { bytes.fill(0); }
  await storeLiveFrame([vault.id, hold ? 'held-phone-v2' : 'phone-v2', id, frame.sequence], operation);
}

export async function heldAudio(vault: Vault, id: string, sequence: number) {
  const store = (await database()).transaction('live-outbox').objectStore('live-outbox');
  const [current, legacy] = await Promise.all([
    request<EncryptedOperation | undefined>(store.get([vault.id, 'held-phone-v2', id, sequence])),
    request<EncryptedOperation | undefined>(store.get([vault.id, 'held-phone', id, sequence])),
  ]);
  return current ? { operation: current, v2: true } : legacy ? { operation: legacy, v2: false } : undefined;
}

export async function releaseHeldAudio(vault: Vault, id: string, fallback: boolean) {
  await change(['live-outbox'], tx => {
    const store = tx.objectStore('live-outbox');
    for (const lane of ['phone', 'phone-v2']) {
      const range = IDBKeyRange.bound([vault.id, 'held-' + lane, id], [vault.id, 'held-' + lane, id, []]);
      const scan = store.openCursor(range);
      scan.onsuccess = () => {
        const row = scan.result;
        if (!row) return;
        if (fallback) store.put(row.value, [vault.id, lane, id, (row.key as IDBValidKey[])[3]]);
        row.delete();
        row.continue();
      };
    }
  });
}

async function pushLive(path: string, vault: Vault, operations: EncryptedOperation[], signal: AbortSignal) {
  const { acknowledgements } = await api<{ acknowledgements: { id: string; seq: number }[] }>(
    path, 'POST', { vault: vault.id, operations }, signal
  );
  if (acknowledgements.length !== operations.length || acknowledgements.some((ack, i) =>
    ack.id !== operations[i].id || !Number.isSafeInteger(ack.seq) || ack.seq <= 0
  )) throw new Error('实时录音同步回执无效');
}

export async function pushLiveAudio(vault: Vault, receiver: 'phone' | 'phone-v2' | 'desktop', signal: AbortSignal, force = false) {
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
  await pushLive(receiver === 'desktop' ? receiptEndpoint : receiver === 'phone-v2' ? liveV2Endpoint : liveEndpoint, vault, operations, signal);
  await change(['live-outbox'], tx => {
    for (const key of keys) tx.objectStore('live-outbox').delete(key);
  });
  if (receiver === 'desktop' && operations.length < 8) pendingDesktopReceipts.delete(vault.id);
  return keys;
}

export async function acknowledgeLiveAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string, title: string, complete?: true) {
  const operation = await sealFrame(vault, root, { kind: 'received', id, title, complete });
  await change(['live-outbox'], tx => {
    const store = tx.objectStore('live-outbox');
    const key = complete ? [vault.id, 'desktop', id, 1] : [vault.id, 'desktop', id];
    const pending = store.getKey(key);
    pending.onsuccess = () => { if (pending.result === undefined) store.add(operation, key); };
  });
  pendingDesktopReceipts.add(vault.id);
}

function decodeLiveFrame(plain: Uint8Array<ArrayBuffer>, v2: boolean): LiveFrame {
  const split = v2 ? plain.indexOf(10) : plain.length;
  if (split < 0 || (v2 && split > 1024)) throw new Error('实时录音标头无效');
  const frame = JSON.parse(decoder.decode(plain.subarray(0, split)));
  if (!uuid.test(frame?.id) || typeof frame.title !== 'string' || !frame.title.trim() || frame.title.length > 160) {
    throw new Error('实时录音标识无效');
  }
  if (!v2 && frame.kind === 'received') return frame;
  if (!('sequence' in frame) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
      frame.sequence >= 1000000) throw new Error('实时录音序号无效');
  if (frame.kind === 'finish' && frame.sequence > 0 && (!v2 || split + 1 === plain.length)) return frame;
  if (frame.kind === 'pcm' && Number.isSafeInteger(frame.offset) && frame.offset >= 0 &&
      frame.offset < WAV_PCM_LIMIT / 2) {
    const pcm = v2 ? { codec: frame.codec, length: frame.length, bytes: plain.slice(split + 1) } : (() => {
      if (typeof frame.data !== 'string' || frame.data.length > Math.ceil(MOBILE_PCM_BYTES * 4 / 3)) throw new Error('实时录音片段无效');
      const bytes = decodeBytes(frame.data);
      return { codec: 'pcm' as const, length: bytes.length, bytes };
    })();
    if (pcm.bytes.length && pcm.bytes.length <= MOBILE_PCM_BYTES) return { ...frame, pcm };
  }
  throw new Error('实时录音片段无效');
}

export async function openLiveAudio(vault: Vault, root: Uint8Array<ArrayBuffer>, operation: EncryptedOperation, v2: boolean) {
  if (!uuid.test(operation.id)) throw new Error('实时录音标识无效');
  const plain = await unseal(root, vault, v2 ? liveV2Purpose : livePurpose, operation.id, operation);
  try { return decodeLiveFrame(plain, v2); }
  finally { plain.fill(0); }
}

export async function pullLiveAudio(
  vault: Vault, root: Uint8Array<ArrayBuffer>, receiver: 'phone' | 'desktop', signal: AbortSignal,
  consume: (frame: LiveFrame) => void | boolean | Promise<void | boolean>, v2 = false
) {
  const db = await database();
  const key = [vault.id, v2 ? 'desktop-v2' : receiver];
  const path = receiver === 'phone' ? receiptEndpoint : v2 ? liveV2Endpoint : liveEndpoint;
  const confirmedKey = [...key, 'confirmed'];
  const stored = db.transaction('live-cursor').objectStore('live-cursor');
  const [saved, savedConfirmation] = await Promise.all([
    request<number | undefined>(stored.get(key)),
    receiver === 'desktop' ? request<number | undefined>(stored.get(confirmedKey)) : undefined,
  ]);
  const after = saved ?? 0;
  let confirmed = savedConfirmation ?? after;
  const pull = async (start: number) => {
    const delta = await api<Delta>(path + '?vault=' + encodeURIComponent(vault.id) + '&after=' + start, 'GET', undefined, signal);
    const acknowledged = delta.acknowledged;
    if (receiver === 'desktop' && acknowledged !== undefined && Number.isSafeInteger(acknowledged) && acknowledged >= 0) {
      confirmed = Math.max(confirmed, acknowledged);
    }
    let cursor = start;
    for (const { seq, ...operation } of delta.operations) {
      signal.throwIfAborted();
      const allowedJump = cursor === start && delta.trimmed && seq > cursor;
      if (!Number.isSafeInteger(seq) || (!allowedJump && seq !== cursor + 1) || !uuid.test(operation.id)) throw new Error('实时录音同步游标不连续');
      cursor = seq;
      const frame = await openLiveAudio(vault, root, operation, v2);
      try {
        if ((frame.kind === 'received') !== (receiver === 'phone')) throw new Error('实时录音事件类型无效');
        if (await consume(frame) !== false && seq === confirmed + 1) confirmed = seq;
      } finally { if (frame.kind === 'pcm') frame.pcm.bytes.fill(0); }
    }
    if (!delta.operations.length && delta.trimmed && delta.cursor > cursor) cursor = delta.cursor;
    if (cursor !== delta.cursor || (cursor === start && delta.more)) throw new Error('实时录音同步游标无效');
    return delta;
  };
  // Repair previously skipped frames before reading new ones. An unresolved prefix must not starve newer recordings.
  const gaps = liveGapRetry.get(vault) ?? new Map<string, number>();
  const replay = receiver === 'desktop' && Date.now() >= (gaps.get(path) ?? 0);
  const start = replay ? Math.min(after, confirmed) : after;
  let delta = await pull(start);
  if (start < after && delta.cursor <= after && delta.more && confirmed < delta.cursor) {
    delta = await pull(after);
  }
  const cursor = Math.max(after, delta.cursor);
  const durable = Math.min(confirmed, cursor);
  if (receiver === 'desktop') {
    if (durable >= cursor) gaps.delete(path);
    else if (replay) gaps.set(path, Date.now() + 30_000);
    if (gaps.size) liveGapRetry.set(vault, gaps);
  }
  if (cursor > after || (receiver === 'desktop' && durable > (savedConfirmation ?? 0))) await change(['live-cursor'], tx => {
    const store = tx.objectStore('live-cursor');
    const advance = (storageKey: string[], value: number) => {
      const prior = store.get(storageKey);
      prior.onsuccess = () => {
        if (prior.result === undefined || value > prior.result) store.put(value, storageKey);
      };
    };
    advance(key, cursor);
    if (receiver === 'desktop') advance(confirmedKey, durable);
  });
  if (receiver === 'desktop') await acknowledgeRemoteAudio(path, vault, durable, delta.acknowledged, signal);
  return delta.more;
}

import { api } from '../api';
import { createPublishedContent, normalizePublishedContent, type PublishedContent } from '../../../../packages/records/src/published-content.mjs';
import type { RecordDetail } from '../model';
import { seal, unseal, type EncryptedOperation, type Vault } from './vault';

export type MeetingCopy = { content: PublishedContent; notes: string };
type Revision = MeetingCopy & { id: string; parents: string[]; at: number };
export type CopySummary = { id: string; sourceId: string; title: string; at: number };
type Row = { key: string; vault: string; pending: 0 | 1; operation: EncryptedOperation; seq: number };
type Delta = { cursor: number; more: boolean; operations: (EncryptedOperation & { seq: number })[] };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const LIMIT = 1024 * 1024;
const identifier = /^[a-f0-9-]{36}$/;

function dbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let opening: Promise<IDBDatabase> | undefined;
function database() {
  if (opening) return opening;
  const request = indexedDB.open('lingji-private-sync', 1);
  request.onupgradeneeded = () => {
    const rows = request.result.createObjectStore('operations', { keyPath: 'key' });
    rows.createIndex('vault', 'vault');
    rows.createIndex('pending', ['vault', 'pending']);
    request.result.createObjectStore('cursor');
    request.result.createObjectStore('heads');
  };
  opening = dbRequest(request).then(db => {
    db.onversionchange = () => { db.close(); opening = undefined; };
    return db;
  }, error => { opening = undefined; throw error; });
  return opening;
}

async function transaction(mode: IDBTransactionMode, body: (tx: IDBTransaction) => void) {
  const db = await database();
  const tx = db.transaction(['operations', 'cursor', 'heads'], mode, { durability: 'strict' });
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('本机同步写入未完成'));
    try { body(tx); }
    catch (error) { tx.abort(); reject(error); }
  });
}

async function readCursor(vault: Vault) {
  const db = await database();
  return Number(await dbRequest(db.transaction('cursor').objectStore('cursor').get(vault.id))) || 0;
}

async function streamBytes(stream: ReadableStream<Uint8Array>, bound: number) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bound) throw new Error('会议超过同步大小上限');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(size);
  let start = 0;
  for (const chunk of chunks) { result.set(chunk, start); start += chunk.byteLength; }
  return result;
}

async function decodeRow(row: Row, vault: Vault, root: Uint8Array<ArrayBuffer>): Promise<Revision> {
  const { operation } = row;
  const clear = await unseal(root, vault, 'revision', operation.id, operation);
  const plain = await streamBytes(new Blob([clear]).stream().pipeThrough(new DecompressionStream('gzip')), LIMIT);
  const value = JSON.parse(decoder.decode(plain));
  if (value.id !== operation.id || !Array.isArray(value.parents) || value.parents.length > 64
    || value.parents.some((id: unknown) => typeof id !== 'string' || !identifier.test(id) || id === value.id)
    || typeof value.notes !== 'string' || value.notes.length > 100_000 || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > 8.64e15) {
    throw new Error('收到格式不受支持的会议修订');
  }
  return { id: operation.id, parents: value.parents, at: value.at, notes: value.notes, content: normalizePublishedContent(value.content) };
}

export async function meetingCopies(vault: Vault, root: Uint8Array<ArrayBuffer>, query = ''): Promise<CopySummary[]> {
  const db = await database();
  const revisions: CopySummary[] = [];
  const superseded = new Set<string>();
  const prefix = vault.id + ':';
  let lower = prefix;
  for (;;) {
    const range = IDBKeyRange.bound(lower, prefix + '\uffff', true);
    const rows = await dbRequest<Row[]>(db.transaction('operations').objectStore('operations').getAll(range, 64));
    for (const row of rows) {
      const revision = await decodeRow(row, vault, root);
      for (const parent of revision.parents) superseded.add(parent);
      if (!query || [revision.content.title, revision.notes, JSON.stringify(revision.content.minutes), JSON.stringify(revision.content.segments || [])]
        .some(value => value.toLowerCase().includes(query))) {
        revisions.push({ id: revision.id, sourceId: revision.content.sourceRecordId, at: revision.at, title: revision.content.title });
      }
    }
    if (rows.length < 64) break;
    lower = rows.at(-1)!.key;
  }
  return revisions.filter(value => !superseded.has(value.id)).sort((left, right) => right.at - left.at);
}

export async function loadMeetingCopy(vault: Vault, root: Uint8Array<ArrayBuffer>, id: string) {
  const db = await database();
  const row = await dbRequest<Row | undefined>(db.transaction('operations').objectStore('operations').get(vault.id + ':' + id));
  if (!row) throw new Error('此副本尚未同步到本机');
  return decodeRow(row, vault, root);
}

export async function queueMeeting(vault: Vault, root: Uint8Array<ArrayBuffer>, record: RecordDetail) {
  if (record.capture !== 'completed') throw new Error('会议处理完成后可同步');
  const content = { ...createPublishedContent({ ...record, liveMinutes: null, id: record.syncSourceId || record.id }, 'full'), draft: false };
  const notes = record.notes ?? '';
  const db = await database();
  const dbKey = vault.id + ':' + record.id;
  const previous = await dbRequest<string | undefined>(db.transaction('heads').objectStore('heads').get(dbKey)) ?? record.syncParent;
  const prior = previous && await dbRequest<Row | undefined>(db.transaction('operations').objectStore('operations').get(vault.id + ':' + previous));
  if (prior) {
    const earlier = await decodeRow(prior, vault, root);
    if (earlier.notes === notes && JSON.stringify(earlier.content) === JSON.stringify(content)) return;
  }
  const id = crypto.randomUUID();
  const revision: Revision = { content, notes, id, parents: previous ? [previous] : [], at: Date.now() };
  const bytes = encoder.encode(JSON.stringify(revision));
  if (bytes.length > LIMIT || notes.length > 100_000) throw new Error('会议超过同步大小上限');
  const zipped = await streamBytes(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')), 190 * 1024);
  const operation = { id, ...await seal(root, vault, 'revision', id, zipped) };
  await transaction('readwrite', tx => {
    tx.objectStore('operations').add({ key: vault.id + ':' + id, vault: vault.id, pending: 1, operation, seq: 0 } satisfies Row);
    tx.objectStore('heads').put(id, dbKey);
  });
}

export async function syncMeetings(vault: Vault, root: Uint8Array<ArrayBuffer>, signal?: AbortSignal) {
  const db = await database();
  let received = false;
  const pending = await dbRequest<Row[]>(db.transaction('operations').objectStore('operations').index('pending').getAll([vault.id, 1], 32));
  for (const row of pending) {
    const { acknowledgements } = await api<{ acknowledgements: { id: string; seq: number }[] }>('/private-sync/delta', 'POST', {
      vault: vault.id, operations: [row.operation],
    }, signal);
    const ack = acknowledgements[0];
    if (ack?.id !== row.operation.id || !Number.isSafeInteger(ack.seq) || ack.seq <= 0) throw new Error('同步确认无效，可以重试');
    await transaction('readwrite', tx => tx.objectStore('operations').put({ ...row, pending: 0, seq: ack.seq }));
  }

  for (let page = 0; page < 32; page++) {
    const after = await readCursor(vault);
    const batch = await api<Delta>('/private-sync/delta?vault=' + vault.id + '&after=' + after, 'GET', undefined, signal);
    let cursor = after;
    const verified: Row[] = [];
    for (const { seq, ...operation } of batch.operations) {
      if (seq !== ++cursor || !identifier.test(operation.id)) throw new Error('同步日志不连续');
      const row = { key: vault.id + ':' + operation.id, vault: vault.id, operation, pending: 0, seq } satisfies Row;
      await decodeRow(row, vault, root);
      verified.push(row);
    }
    if (batch.cursor !== cursor || (cursor === after && batch.more)) throw new Error('同步游标无效');
    received ||= verified.length > 0;
    await transaction('readwrite', tx => {
      const saved = tx.objectStore('cursor').get(vault.id);
      saved.onsuccess = () => {
        if ((saved.result ?? 0) >= cursor) return;
        for (const row of verified) tx.objectStore('operations').put(row);
        tx.objectStore('cursor').put(cursor, vault.id);
      };
    });
    if (!batch.more) break;
  }
  const morePending = await dbRequest(db.transaction('operations').objectStore('operations').index('pending').count([vault.id, 1]));
  return { pending: morePending, received };
}

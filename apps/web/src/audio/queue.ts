import { api, ApiError } from '../api';
import type { AudioChunk } from '../model';
interface Pending { key: string; recordId: string; chunk: AudioChunk; bytes: number; createdAt: number }
interface Manifest { key: string; recordId: string; sourceId: string; epoch: string; lastSequence: number }
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('meeting-studio-audio', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('chunks', { keyPath: 'key' }); request.result.createObjectStore('manifests', { keyPath: 'key' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function all<T>(store: string): Promise<T[]> {
  const database = await db(); return new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function write(store: string, value: unknown, remove = false) {
  const database = await db(); return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite'); if (remove) tx.objectStore(store).delete(value as IDBValidKey); else tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('本地存储已满。'));
  });
}
export const localManifests = async (recordId: string) => (await all<Manifest>('manifests')).filter(m => m.recordId === recordId);
export const pendingCount = async (recordId?: string) => (await all<Pending>('chunks')).filter(c => !recordId || c.recordId === recordId).length;
export async function enqueue(recordId: string, chunk: AudioChunk) {
  const pending = await all<Pending>('chunks');
  if (pending.reduce((n, c) => n + c.bytes, 0) + chunk.sampleCount * 2 > 48 * 1024 * 1024) throw new Error('本地待传音频超过 48 MB，录音已暂停。请恢复网络后继续。');
  const key = `${recordId}:${chunk.sourceId}:${chunk.epoch}:${chunk.sequence}`;
  await write('chunks', { key, recordId, chunk, bytes: chunk.sampleCount * 2, createdAt: Date.now() });
  await write('manifests', { key: `${recordId}:${chunk.sourceId}`, recordId, sourceId: chunk.sourceId, epoch: chunk.epoch, lastSequence: chunk.sequence });
}
let uploading = false;
let permittedRecords = new Set<string>();
export const setQueueRecords = (ids: string[]) => { permittedRecords = new Set(ids); };
export async function drainQueue(onChange?: () => void) {
  if (uploading || !navigator.onLine) return; uploading = true;
  try {
    const entries = (await all<Pending>('chunks')).filter(entry => permittedRecords.has(entry.recordId)).sort((a, b) => a.createdAt - b.createdAt || a.chunk.sequence - b.chunk.sequence);
    for (const entry of entries) {
      try { await api(`/records/${entry.recordId}/audio`, 'POST', entry.chunk); await write('chunks', entry.key, true); onChange?.(); }
      catch (error) {
        if (error instanceof ApiError && error.status === 410) { await write('chunks', entry.key, true); continue; }
        if (error instanceof ApiError && error.status === 404) continue;
        throw error;
      }
    }
  } finally { uploading = false; }
}
export async function clearRecordAudio(recordId: string) {
  for (const c of await all<Pending>('chunks')) if (c.recordId === recordId) await write('chunks', c.key, true);
  for (const m of await localManifests(recordId)) await write('manifests', m.key, true);
}
export async function makeChunk(sourceId: string, epoch: string, sequence: number, sampleOffset: number, buffer: ArrayBuffer): Promise<AudioChunk> {
  const bytes = new Uint8Array(buffer); const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { sourceId, epoch, sequence, sampleOffset, sampleCount: bytes.length / 2, sampleRate: 16000,
    digest: Array.from(hash, b => b.toString(16).padStart(2, '0')).join(''), pcm: btoa(binary) };
}

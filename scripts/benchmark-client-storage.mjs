import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord, emit } from '../packages/records/src/record.mjs';
import { encodeStorage, decodeStorage } from '../services/records/src/storage-codec.mjs';

delete process.env.RECORD_DATABASE_URL; delete process.env.RECORD_S3_BUCKET;
const root = await mkdtemp(join(tmpdir(), 'client-storage-benchmark-'));
try {
  const source = createRecord('fixture', { title: 'Synthetic 120-minute local storage fixture', retainAudio: true });
  source.gcAt = Date.now();
  const sourceId = randomUUID(), epoch = randomUUID(), sessionId = randomUUID();
  source.sources = [{ id: sourceId, epoch, sessionId, watermark: 7199, lastSequence: null, stopped: false, kind: 'microphone' }];
  for (let i = 0; i < 7200; i++) source.chunks.push({ key: `${sessionId}:${sourceId}:${epoch}:${i}`, sourceId, sessionId, epoch, sequence: i, sampleOffset: i * 16000, sampleCount: 16000, sampleRate: 16000, digest: 'a'.repeat(64), state: 'done', acceptedAt: Date.now() });
  for (let i = 0; i < 1440; i++) source.segments.push({ id: `segment-${i}`, revision: 1, sourceId, startMs: i * 5000, endMs: (i + 1) * 5000, text: 'Synthetic discussion with cited evidence and preserved revisions. '.repeat(4) });
  source.transcriptRevision = source.segments.length; emit(source, 'synthetic');
  const variants = [];
  for (const compressed of [false, true]) {
    const directory = join(root, compressed ? 'compressed' : 'plain');
    const repo = await createRepository({ root: directory, databaseUrl: '', compressAggregates: compressed });
    const record = structuredClone(source); await repo.insert(record);
    const times = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      await repo.change(record.id, r => { r.notes = `Synthetic note ${i}`; emit(r, 'notes.updated'); });
      times.push(performance.now() - started);
    }
    const snapshot = await repo.get(record.id); assert.equal(snapshot.segments.length, 1440); assert.equal(snapshot.notes, 'Synthetic note 9');
    await repo.close();
    const reopened = await createRepository({ root: directory, databaseUrl: '' });
    assert.equal((await reopened.get(record.id)).notes, 'Synthetic note 9'); await reopened.close();
    times.sort((a, b) => a - b);
    variants.push({ compressed, sqliteBytes: (await stat(join(directory, 'records.sqlite'))).size, writeP50Ms: times[5], writeMaxMs: times.at(-1) });
  }
  let seed = 1; const silence = Buffer.alloc(32000), tone = Buffer.alloc(32000), noise = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) {
    tone.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 12000), i * 2);
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noise.writeInt16LE((seed & 65535) - 32768, i * 2);
  }
  const audio = Object.entries({ silence, tone, noise }).map(([kind, bytes]) => {
    const encoded = encodeStorage(bytes); assert.deepEqual(decodeStorage(encoded.bytes, createHash('sha256').update(bytes).digest('hex')), bytes);
    return { kind, inputBytes: bytes.length, storedBytes: encoded.bytes.length, compressed: encoded.compressed };
  });
  const output = { timestamp: new Date().toISOString(), scenario: 'synthetic 120min/7200 chunks/1440 segments, 10 metadata writes; no real recordings', variants, sqliteSavedPercent: 100 * (1 - variants[1].sqliteBytes / variants[0].sqliteBytes), audio, limits: 'Fixture evidence only; audio entropy and real speech were not measured.' };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output));
} finally { await rm(root, { recursive: true, force: true }); }

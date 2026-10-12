// Synthetic storage microbenchmark. Never loads .env or uses business data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord, emit, publicRecord } from '../packages/records/src/record.mjs';

// S3's constructor falls back to environment variables; explicitly disable it.
delete process.env.RECORD_S3_BUCKET;
const root = await mkdtemp(join(tmpdir(), 'tts-aggregate-benchmark-'));
const repo = await createRepository({ root, databaseUrl: '' });
const samples = 20;
const results = [];
function syntheticRecord(minutes, sourceCount) {
  const record = createRecord('synthetic-benchmark', { title: '合成性能样本' });
  record.capture = 'recording'; record.gcAt = Date.now();
  for (let s = 0; s < sourceCount; s++) {
    const sourceId = randomUUID(), epoch = randomUUID(), sessionId = randomUUID();
    record.sources.push({ id: sourceId, epoch, sessionId, kind: s ? 'display' : 'microphone', watermark: minutes * 60 - 1 });
    for (let sequence = 0; sequence < minutes * 60; sequence++) {
      const key = `${sourceId}:${epoch}:${sequence}`;
      record.chunks.push({ key, sourceId, epoch, sessionId, sequence, sampleOffset: sequence * 16000,
        sampleCount: 16000, sampleRate: 16000, digest: sequence.toString(16).padStart(64, '0'),
        object: `${record.id}/${sequence.toString(16).padStart(64, '0')}`, state: 'done', attempts: 0, acceptedAt: Date.now() });
      if (sequence % 5 === 0) record.segments.push({ id: randomUUID(), revision: 1, sourceId, chunkKey: key,
        startMs: sequence * 1000, endMs: (sequence + 5) * 1000,
        text: '这是一段虚构会议的合成转录，用于测量记录序列化与存储成本，不代表真实模型输出。', speaker: '发言人1', edited: false });
    }
  }
  record.usage.samples = minutes * 60 * sourceCount * 16000;
  record.transcriptRevision = record.segments.length;
  for (let i = 0; i < 1000; i++) emit(record, 'benchmark.synthetic');
  return record;
}
async function measure(fn) {
  for (let i = 0; i < 3; i++) await fn();
  const times = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now(); await fn(); times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { medianMs: +times[Math.floor(times.length / 2)].toFixed(3), p95Ms: +times[Math.ceil(times.length * .95) - 1].toFixed(3) };
}
try {
  for (const [minutes, sources] of (process.argv.includes('--matrix') ? [5,30,60,120].flatMap(minutes=>[1,2].map(sources=>[minutes,sources])) : [[5, 2], [30, 2], [60, 2], [120, 1]])) {
    const record = syntheticRecord(minutes, sources);
    await repo.insert(record);
    const snapshotCharacters = JSON.stringify(record.segments).length;
    results.push({ wallMinutes: minutes, sources, withinCaptureCapacity:record.chunks.length<=10000 && record.usage.samples<=16000*60*120, chunks: record.chunks.length, segments: record.segments.length,
      aggregateBytes: Buffer.byteLength(JSON.stringify(record)), publicBytes: Buffer.byteLength(JSON.stringify(publicRecord(record))),
      snapshotCharacters, exceedsFinalSnapshotGuard: snapshotCharacters > 180000,
      get: await measure(() => repo.get(record.id)),
      changeScalar: await measure(() => repo.change(record.id, r => { emit(r, 'benchmark.tick'); return r.cursor; })),
      publicSerialize: await measure(() => JSON.stringify(publicRecord(record))) });
  }
  const due = syntheticRecord(30, 2);
  for (let i = 0; i < 20-results.length; i++) await repo.insert({ ...structuredClone(due), id: randomUUID() });
  const listWork20 = await measure(() => repo.listWork());
  const list20 = await measure(() => repo.list());
  let n = 0;
  const audioDurability = await measure(() => { const pcm = Buffer.alloc(32000); pcm.writeUInt32LE(++n); return repo.putAudio(due.id, pcm); });
  console.log(JSON.stringify({ schema: 'tts-synthetic-aggregate-benchmark/v1', at: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    backend: repo.backend, audioBackend: repo.audioBackend, samples, warmup: 3,
    method: 'Sequential warm local operations, synthetic metadata only, no ASR/LLM/HTTP/browser/concurrent clients. SQLite WAL synchronous=FULL. No minutes history. Not a capacity or latency SLO test.',
    cases: results, library20Records: { listWork: listWork20, list: list20 }, oneSecondAudioPut: audioDurability }, null, 2));
} finally {
  await repo.close(); await rm(root, { recursive: true, force: true });
}

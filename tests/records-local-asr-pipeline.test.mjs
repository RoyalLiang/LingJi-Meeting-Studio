import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { migrateBundledAsr } from '../services/records/src/desktop-backend.mjs';
import { defaults, readConfig, saveConfig } from '../services/records/src/config.mjs';
import { processFunasrAudio } from '../services/records/src/funasr-transcription.mjs';
import { LOCAL_ASR_MODEL } from '../services/records/src/local-asr.mjs';
import { createRecord, addSource, acknowledge, commitTranscriptBatch, editSegment, pause, digest, requestMinutes } from '../packages/records/src/record.mjs';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-local-pipeline-'));
  const prior = process.env.LINGJI_LOCAL_ASR_DIR;
  await writeFile(join(root, 'manifest.json'), '{}'); process.env.LINGJI_LOCAL_ASR_DIR = root;
  const repo = await createRepository({ root });
  try { await work(repo, root); }
  finally { if (prior === undefined) delete process.env.LINGJI_LOCAL_ASR_DIR; else process.env.LINGJI_LOCAL_ASR_DIR = prior; await repo.close(); await rm(root, { recursive: true, force: true }); }
}
async function audioRecord(repo, human = false) {
  const record = createRecord('owner', { language: 'zh', autoMinutes: false });
  const sources = [addSource(record, { kind: 'microphone' })];
  if (human) sources.push(addSource(record, { kind: 'display' }));
  await repo.insert(record);
  for (const source of sources) {
    const bytes = Buffer.alloc(3 * 32000); for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(5000, i);
    const object = await repo.putAudio(record.id, bytes);
    await repo.change(record.id, r => acknowledge(r, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 0, sampleOffset: 0, sampleCount: bytes.length / 2, sampleRate: 16000, digest: digest(bytes), ...object }));
  }
  if (human) await repo.change(record.id, r => {
    const chunk = r.chunks[0]; commitTranscriptBatch(r, [chunk.key], '旧的转录', r.generation, 'sensevoice', { provider: 'funasr' });
    editSegment(r, r.segments[0].id, { revision: 1, text: '人工确认内容', speaker: '主持人' });
  });
  await repo.change(record.id, r => pause(r, sources.map(s => ({ sessionId: s.sessionId, sourceId: s.id, epoch: s.epoch, lastSequence: 0 }))));
  return repo.get(record.id);
}
test('old default local server migrates and drains failed audio, preserving human revision and source identity', async () => fixture(async (repo, root) => {
  await writeFile(join(root, 'providers.json'), JSON.stringify({ ASR_PROVIDER: 'funasr', FUNASR_API_URL: defaults.FUNASR_API_URL, FUNASR_MODEL: 'sensevoice' }));
  const record = await audioRecord(repo, true), failedSource = record.sources[1].id;
  await repo.change(record.id, r => {
    const chunk = r.chunks[1]; chunk.attempts = 5; chunk.retryAt = Date.now() + 60000; chunk.error = 'funasr_service_unavailable';
    r.sources[1].asr = { provider: 'funasr', state: 'failed', error: chunk.error }; r.transcription = 'blocked';
  });
  const keys = record.chunks.map(c => c.key);
  assert.equal(await migrateBundledAsr(repo), true);
  const config = await readConfig(root); assert.equal(config.ASR_PROVIDER, 'sensevoice-local');
  assert.equal(await migrateBundledAsr(repo), false);
  let invoked = 0;
  await processFunasrAudio(repo, await repo.get(record.id), config, async bytes => { invoked++; assert.equal(bytes.length, 96000); return '新的本地转录'; });
  const result = await repo.get(record.id);
  assert.equal(invoked, 1); assert.ok(result.chunks.every(c => c.state === 'done'));
  assert.deepEqual(result.chunks.map(c => c.key), keys);
  assert.equal(result.segments[0].text, '人工确认内容'); assert.equal(result.segments[0].revision, 2);
  const current = result.segments.find(s => s.sourceId === failedSource);
  assert.equal(current.transcriptProvider, 'sensevoice-local'); assert.equal(current.modelVersion, LOCAL_ASR_MODEL);
  assert.deepEqual(current.chunkKeys, [keys[1]]);
  const job = requestMinutes(result, { scope: 'live' }); assert.equal(job.snapshot[0].revision, 2);
}));
test('upgrade preserves a deliberately configured remote/private FunASR deployment and its credentials', async () => fixture(async (repo, root) => {
  for (const values of [
    { ASR_PROVIDER: 'funasr', FUNASR_API_URL: 'https://private.example/v1/audio/transcriptions', FUNASR_MODEL: 'sensevoice' },
    { ASR_PROVIDER: 'funasr', FUNASR_API_URL: defaults.FUNASR_API_URL, FUNASR_MODEL: 'sensevoice', FUNASR_API_KEY: 'private-key' },
    { ASR_PROVIDER: 'doubao', DOUBAO_API_KEY: 'configured-key' },
  ]) {
    const text = JSON.stringify(values); await writeFile(join(root, 'providers.json'), text);
    assert.equal(await migrateBundledAsr(repo), false);
    assert.equal((await readConfig(root)).ASR_PROVIDER, values.ASR_PROVIDER);
  }
}));
test('provider switch rejects obsolete native output and releases durable audio without consuming retries', async () => fixture(async (repo, root) => {
  await saveConfig(root, { ASR_PROVIDER: 'sensevoice-local' }); const record = await audioRecord(repo);
  let release, entered; const gate = new Promise(done => { entered = done; }); const waiting = new Promise(done => { release = done; });
  const work = processFunasrAudio(repo, record, await readConfig(root), async () => { entered(); await waiting; return '过期结果'; });
  await gate; await saveConfig(root, { ASR_PROVIDER: 'doubao' }); release(); await work;
  const result = await repo.get(record.id);
  assert.equal(result.segments.length, 0); assert.equal(result.chunks[0].attempts, 0); assert.equal(result.chunks[0].state, 'pending');
}));
test('normal shutdown releases a native claim without persisting a service failure', async () => fixture(async (repo, root) => {
  await saveConfig(root, { ASR_PROVIDER: 'sensevoice-local' }); const record = await audioRecord(repo);
  await processFunasrAudio(repo, record, await readConfig(root), async () => { const error = new Error('shutdown'); error.code = 'local_asr_shutdown'; throw error; });
  const result = await repo.get(record.id);
  assert.equal(result.chunks[0].attempts, 0); assert.equal(result.chunks[0].state, 'pending');
  assert.equal(result.sources[0].asr?.state === 'failed', false);
}));

test('interrupted upgrade resumes remaining failed sources before committing provider', async () => fixture(async (repo, root) => {
  await writeFile(join(root, 'providers.json'), JSON.stringify({ ASR_PROVIDER: 'funasr', FUNASR_API_URL: defaults.FUNASR_API_URL, FUNASR_MODEL: 'sensevoice' }));
  const records = [await audioRecord(repo), await audioRecord(repo)];
  for (const record of records) await repo.change(record.id, r => {
    r.chunks[0].attempts = 5; r.chunks[0].error = 'funasr_service_unavailable';
    r.sources[0].asr = { provider: 'funasr', state: 'failed' };
  });
  const change = repo.change.bind(repo); let calls = 0;
  repo.change = async (...args) => { if (++calls === 2) throw new Error('interrupted'); return change(...args); };
  await assert.rejects(migrateBundledAsr(repo), /interrupted/);
  assert.equal((await readConfig(root)).ASR_PROVIDER, 'funasr');
  repo.change = change;
  assert.equal(await migrateBundledAsr(repo), true);
  assert.equal((await readConfig(root)).ASR_PROVIDER, 'sensevoice-local');
  for (const record of records) {
    const current = await repo.get(record.id);
    assert.equal(current.sources[0].asr.provider, 'sensevoice-local');
    assert.equal(current.chunks[0].attempts, 0);
    assert.equal(current.transcriptionRetryVersion, 1);
  }
}));

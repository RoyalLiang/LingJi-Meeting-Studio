import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from '../services/records/src/repository.mjs';
import { readConfig } from '../services/records/src/config.mjs';
import { processFunasrAudio } from '../services/records/src/funasr-transcription.mjs';
import { LocalAsrClient, LOCAL_STREAMING_ASR_MODEL, localStreamingAsrConfigured } from '../services/records/src/local-asr.mjs';
import { createRecord, addSource, acknowledge, pause, digest } from '../packages/records/src/record.mjs';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-streaming-asr-'));
  const prior = process.env.LINGJI_LOCAL_ASR_DIR;
  process.env.LINGJI_LOCAL_ASR_DIR = root;
  const repo = await createRepository({ root });
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ streamingModel: { model: LOCAL_STREAMING_ASR_MODEL } }));
    const config = await readConfig(root), record = createRecord('owner', { language: 'zh', autoMinutes: false });
    const source = addSource(record, { kind: 'microphone' });
    await repo.insert(record);
    const append = async sequence => {
      const bytes = Buffer.alloc(32000); for (let at = 0; at < bytes.length; at += 2) bytes.writeInt16LE(5000, at);
      const object = await repo.putAudio(record.id, bytes);
      await repo.change(record.id, r => acknowledge(r, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence, sampleOffset: sequence * 16000, sampleCount: 16000, sampleRate: 16000, digest: digest(bytes), ...object }));
    };
    await work({ root, repo, config, record, source, append });
  } finally {
    if (prior === undefined) delete process.env.LINGJI_LOCAL_ASR_DIR; else process.env.LINGJI_LOCAL_ASR_DIR = prior;
    await repo.close(); await rm(root, { recursive: true, force: true });
  }
}
const preview = async (pcm, config, context) => ({ text: '实时草稿', startSample: context.sampleOffset, endSample: context.sampleOffset + pcm.length / 2 });

test('online preview advances on new durable audio before batch retry and only final ASR creates canonical evidence', async () => fixture(async ({ repo, config, record, source, append }) => {
  let finalCalls = 0, onlineCalls = 0;
  const final = async () => { finalCalls++; return { text: '最终校正内容', language: 'zh' }; };
  const online = async (...args) => { onlineCalls++; return preview(...args); };
  await append(0); await processFunasrAudio(repo, record, config, final, online);
  let current = await repo.get(record.id);
  assert.equal(current.sources[0].asr.preview.text, '实时草稿');
  assert.equal(current.sources[0].asr.runtime.streaming, true);
  assert.equal(current.segments.length, 0); assert.equal(finalCalls, 0);
  assert.ok(current.events.some(event => event.type === 'asr.partial'));
  await append(1); await processFunasrAudio(repo, current, config, final, online);
  assert.equal(onlineCalls, 2); assert.equal(finalCalls, 0);
  await repo.change(record.id, r => pause(r, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 1 }]));
  await processFunasrAudio(repo, current, config, final, online);
  current = await repo.get(record.id);
  assert.equal(current.segments[0].text, '最终校正内容'); assert.equal(finalCalls, 1);
  assert.equal(current.sources[0].asr.preview, undefined);
  assert.ok(current.chunks.every(chunk => chunk.state === 'done'));
}));

test('online revision to empty clears stale draft and its translation', async () => fixture(async ({ repo, config, record, append }) => {
  await append(0); await processFunasrAudio(repo, record, config, async () => assert.fail('premature final'), preview);
  await repo.change(record.id, r => { r.sources[0].asr.translation = { text: 'old translated draft' }; });
  await append(1); await processFunasrAudio(repo, record, config, async () => assert.fail('premature final'), async (...args) => ({ ...await preview(...args), text: '' }));
  const current = await repo.get(record.id); assert.equal(current.sources[0].asr.preview, undefined); assert.equal(current.sources[0].asr.translation, undefined);
}));

test('online failure remains visible and retains durable audio for final recognition', async () => fixture(async ({ repo, config, record, source, append }) => {
  await append(0);
  await processFunasrAudio(repo, record, config, async () => assert.fail('premature final'), async () => { throw Error('native failed'); });
  let current = await repo.get(record.id);
  assert.equal(current.sources[0].asr.previewError, 'local_streaming_asr_failed');
  assert.equal(current.chunks[0].state, 'pending');
  await repo.change(record.id, r => pause(r, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]));
  await processFunasrAudio(repo, current, config, async () => ({ text: '完整正文', language: 'zh' }), preview);
  current = await repo.get(record.id); assert.equal(current.segments[0].text, '完整正文');
  assert.equal(current.sources[0].asr.previewError, undefined);
}));

test('stopped audio bypasses optional online draft so a stalled preview cannot delay final drain', async () => fixture(async ({ repo, config, record, source, append }) => {
  await append(0);
  await repo.change(record.id, r => pause(r, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]));
  await processFunasrAudio(repo, record, config, async () => ({ text: '停止后完整正文', language: 'zh' }), async () => assert.fail('stopped draft must not run'));
  assert.equal((await repo.get(record.id)).segments[0].text, '停止后完整正文');
}));

test('optional diarization failure keeps complete final text and a visible identity notice', async () => fixture(async ({ repo, config, record, source, append }) => {
  await append(0);
  await repo.change(record.id, r => pause(r, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]));
  await processFunasrAudio(repo, record, config, async () => ({ text: '完整的最终正文', language: 'zh', diarizationError: 'local_diarization_unavailable' }), preview);
  const current = await repo.get(record.id); assert.equal(current.segments[0].text, '完整的最终正文'); assert.equal(current.sources[0].asr.identityWarning, 'local_diarization_unavailable');
}));

test('late online result cannot cross a generation fence', async () => fixture(async ({ repo, config, record, append }) => {
  await append(0);
  await processFunasrAudio(repo, record, config, async () => assert.fail('stale final'), async (...args) => {
    await repo.change(record.id, r => { r.generation++; }); return preview(...args);
  });
  assert.equal((await repo.get(record.id)).sources[0].asr?.preview, undefined);
}));

test('non bilingual language keeps authoritative batch path without incompatible online drafts', async () => fixture(async ({ repo, config, record, append }) => {
  await repo.change(record.id, r => { r.language = 'ja'; });
  await append(0); await processFunasrAudio(repo, record, config, async () => assert.fail('short batch'), async () => assert.fail('incompatible online'));
  assert.equal((await repo.get(record.id)).sources[0].asr?.preview, undefined);
}));

test('auto language detected outside bilingual model skips incompatible online inference', async () => fixture(async ({ repo, config, record, append }) => {
  await repo.change(record.id, r => { r.language = 'auto'; r.sources[0].asr = { streamingLanguage: 'ja', streaming: false }; });
  await append(0); await processFunasrAudio(repo, record, config, async () => assert.fail('short batch'), async () => assert.fail('incompatible online'));
  assert.equal((await repo.get(record.id)).sources[0].asr.preview, undefined);
}));

test('legacy bundled model manifest does not claim streaming support', async () => fixture(async ({ root, config }) => {
  assert.equal(localStreamingAsrConfigured(config), true);
  await writeFile(join(root, 'manifest.json'), '{}');
  assert.equal(localStreamingAsrConfigured(config), false);
}));

test('streaming IPC rejects mismatched sample intervals and malformed request context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-stream-ipc-')), worker = join(root, 'worker.mjs');
  await writeFile(worker, `import {createInterface} from 'node:readline';console.log(JSON.stringify({protocol:1,ready:true,model:${JSON.stringify(LOCAL_STREAMING_ASR_MODEL)}}));for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);console.log(JSON.stringify({id:r.id,text:'draft',startSample:0,endSample:999}));}`);
  const client = new LocalAsrClient(root, { workerPath: worker, verify: async () => {}, model: LOCAL_STREAMING_ASR_MODEL, timeoutMs: 2000 });
  try {
    assert.throws(() => client.transcribe(Buffer.alloc(4), { context: { key: '', sampleOffset: 0, final: false } }), { code: 'invalid_local_asr_audio' });
    await assert.rejects(client.transcribe(Buffer.alloc(4), { context: { key: 'source', sampleOffset: 0, final: false } }), { code: 'local_asr_invalid_response' });
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDoubaoAudioMinutes, testDoubaoAudio } from '../services/records/src/doubao-audio-minutes.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { normalizeConfig, saveConfig, readConfig, publicConfig, minutesModelVersion } from '../services/records/src/config.mjs';
import { buildMinutesManifest } from '../services/records/src/minutes-pipeline.mjs';
import { providerStatus } from '../services/records/src/providers.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { createRecord, addSource, acknowledge, digest, requestMinutes, seal, editSegment } from '../packages/records/src/record.mjs';

async function fixture(work, respond) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-doubao-audio-')), requests = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes); requests.push(body);
    if (respond) return respond(body, res);
    const content = body.input.at(-1).content;
    const data = JSON.parse(content.at(-1).text), refs = data.transcript || [];
    const result = refs.length ? { title: '音频纪要', sections: [{ heading: '讨论', items: refs.map(segment => ({ text: segment.text, evidence: [{ segmentId: segment.id, revision: segment.revision }] })) }], actions: [] } : { ok: true };
    const text = JSON.stringify(result);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } })}\n\n`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output_text: text, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = normalizeConfig({ NODE_ENV: 'test', MINUTES_MODE: 'doubao-audio', LLM_PROTOCOL: 'responses', LLM_API_URL: `http://127.0.0.1:${server.address().port}/responses`, LLM_MODEL: 'fixture-audio', LLM_API_KEY: 'fixture-key' });
  try { await work(await createRepository({ root }), config, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
}

async function recorded(repo, config, { consent = true, retainAudio = true } = {}) {
  await saveConfig(repo.root, config, { NODE_ENV: 'test' });
  const record = createRecord('fixture-owner', { autoMinutes: true, realtimeAudioConsent: consent, retainAudio });
  const source = addSource(record, { kind: 'import' });
  await repo.insert(record);
  const bytes = Buffer.alloc(32000, 3), object = await repo.putAudio(record.id, bytes);
  await repo.change(record.id, current => acknowledge(current, { ...object, sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 0, sampleOffset: 0, sampleCount: 16000, sampleRate: 16000, digest: digest(bytes) }));
  return { record: await repo.get(record.id), source, bytes };
}
const jobFor = (record, source) => ({ generation: record.generation, scope: 'live', mode: 'model', template: 'standard', snapshot: [{ id: 's1', revision: 1, sourceId: source.id, startMs: 0, endMs: 1000, text: '小林下周三提交测试结果，上线待定。' }] });

test('Doubao audio is explicit, requires Responses and masks its shared server secret', async () => fixture(async (repo, config) => {
  assert.equal(providerStatus(config).minutes, true);
  assert.equal(providerStatus({ ...config, LLM_PROTOCOL: 'chat-completions' }).minutes, false);
  assert.equal(minutesModelVersion(config), 'doubao-audio:fixture-audio');
  assert.equal(publicConfig(config).LLM_API_KEY, true);
  await assert.rejects(saveConfig(repo.root, { ...config, LLM_PROTOCOL: 'chat-completions' }, { NODE_ENV: 'test' }), { code: 'doubao_audio_requires_responses' });
  await saveConfig(repo.root, config, { NODE_ENV: 'test' });
  await saveConfig(repo.root, { LLM_API_KEY: '' }, { NODE_ENV: 'test' });
  assert.equal((await readConfig(repo.root, {})).LLM_API_KEY, 'fixture-key');
}));

test('Doubao receives native WAV with frozen transcript refs, streamed output and usage', async () => fixture(async (repo, config, requests) => {
  const { record, source, bytes } = await recorded(repo, config), job = jobFor(record, source);
  let deltas = '', usage;
  const result = await generateDoubaoAudioMinutes(repo, record.id, job, config, { onDelta(delta) { deltas += delta; }, onUsage(value) { usage = value; } });
  assert.equal(result.runtime.inputMode, 'doubao-audio');
  assert.equal(result.runtime.streamed, true); assert.ok(deltas.includes('音频纪要'));
  assert.equal(usage.totalTokens, 30);
  assert.deepEqual(result.sections[0].items[0].evidence, [{ segmentId: 's1', revision: 1 }]);
  const body = requests[0], content = body.input.at(-1).content;
  assert.equal(body.store, false); assert.equal(body.model, 'fixture-audio'); assert.equal(body.tools, undefined);
  const wav = Buffer.from(content.find(item => item.type === 'input_audio').audio_url.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1);
  assert.deepEqual(wav.subarray(44), bytes);
  assert.equal(result.audioEvidence[0].chunkKey, record.chunks[0].key);
  assert.equal(JSON.parse(content.at(-1).text).audio[0].startMs, 0);
}));

test('Doubao rejects missing consent or expired audio before any request', async () => fixture(async (repo, config, requests) => {
  const { record, source } = await recorded(repo, config, { consent: false });
  await assert.rejects(generateDoubaoAudioMinutes(repo, record.id, jobFor(record, source), config), { code: 'realtime_audio_consent_required' });
  await repo.change(record.id, current => { current.realtimeAudioConsent = true; current.chunks[0].expired = true; });
  await assert.rejects(generateDoubaoAudioMinutes(repo, record.id, jobFor(record, source), config), { code: 'audio_minutes_audio_unavailable' });
  assert.equal(requests.length, 0);
}));

test('Doubao preserves timeline gaps and rejects oversized spans without allocating them', async () => fixture(async (repo, config, requests) => {
  const { record, source, bytes } = await recorded(repo, config);
  const object = await repo.putAudio(record.id, bytes);
  await repo.change(record.id, current => acknowledge(current, { ...object, sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 1, sampleOffset: 16000, sampleCount: 16000, sampleRate: 16000, digest: digest(bytes) }));
  await repo.change(record.id, current => { current.chunks[1].sampleOffset = 32000; });
  const job = jobFor(record, source); job.snapshot[0].endMs = 3000;
  await generateDoubaoAudioMinutes(repo, record.id, job, config);
  const url = requests[0].input.at(-1).content.find(item => item.type === 'input_audio').audio_url;
  const wav = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(wav.length, 44 + 96000); assert.deepEqual(wav.subarray(44 + 32000, 44 + 64000), Buffer.alloc(32000));
  await repo.change(record.id, current => { current.chunks[1].sampleOffset = 16000 * 600; });
  job.snapshot[0].endMs = 601000;
  await assert.rejects(generateDoubaoAudioMinutes(repo, record.id, job, config), { code: 'audio_minutes_window_limit' });
  assert.equal(requests.length, 1);
}));

test('Doubao failures preserve billed usage and never fall back to text', async () => fixture(async (repo, config, requests) => {
  const { record, source } = await recorded(repo, config); let usage;
  await assert.rejects(generateDoubaoAudioMinutes(repo, record.id, jobFor(record, source), config, { onDelta() {}, onUsage(value) { usage = value; } }), { code: 'llm_stream_failed' });
  assert.equal(usage.totalTokens, 7); assert.equal(requests.length, 1);
}, (_body, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { usage: { total_tokens: 7 } } })}\n\n`); }));

test('Doubao rejects invented transcript references', async () => fixture(async (repo, config) => {
  const { record, source } = await recorded(repo, config);
  await assert.rejects(generateDoubaoAudioMinutes(repo, record.id, jobFor(record, source), config), { code: 'unknown_evidence' });
}, (_body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ output_text: JSON.stringify({ title: '错误', sections: [{ heading: '错误引用', items: [{ text: '事项', evidence: [{ segmentId: 'invented', revision: 9 }] }] }] }) })); }));

test('Doubao long meetings use bounded source windows and separate mode cache keys', () => {
  const snapshot = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, revision: 1, text: '会议信息', sourceId: `track${i}`, startMs: 0, endMs: 3 * 60 * 60 * 1000 }));
  const job = { snapshot, mode: 'model', scope: 'final', generation: 1, modelVersion: 'fixture-audio' };
  const manifest = buildMinutesManifest(job, { MINUTES_MODE: 'doubao-audio' });
  assert.equal(manifest.windows.length, 270);
  for (const window of manifest.windows) { assert.equal(new Set(window.snapshot.map(s => s.sourceId)).size, 1); assert.ok(window.snapshot.every(s => s.endMs - s.startMs <= 120000)); }
  assert.notEqual(manifest.policy, buildMinutesManifest(job, { MINUTES_MODE: 'asr-llm' }).policy);
});

test('Doubao worker keeps parallel ASR evidence, finalizes and releases temporary raw audio', async () => fixture(async (repo, config, requests) => {
  const { record, source } = await recorded(repo, config, { retainAudio: false });
  await repo.change(record.id, current => seal(current, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]));
  await runCycle(repo, { transcribe: async () => '小林下周三提交测试结果，上线待定。' }, { lane: 'audio' });
  await repo.change(record.id, current => requestMinutes(current, { mode: 'model' }));
  await runCycle(repo, {}, { lane: 'minutes' });
  const final = await repo.get(record.id);
  assert.equal(final.jobs.at(-1).status, 'completed'); assert.equal(final.minutes.runtime.inputMode, 'doubao-audio');
  assert.equal(final.minutes.transcriptRevision, final.transcriptRevision);
  assert.ok(requests[0].input.at(-1).content.some(item => item.type === 'input_audio'));
  assert.ok(final.usage.llmTokens > 0);
  await runCycle(repo, {}, { lane: 'audio' });
  assert.equal((await repo.get(record.id)).audioPurged, true);
}));

test('Doubao late model output cannot replace a revised transcript', async () => {
  let revisionWork, resolveSent; const sent = new Promise(resolve => { resolveSent = resolve; });
  await fixture(async (repo, config) => {
    const { record, source } = await recorded(repo, config);
    await repo.change(record.id, current => seal(current, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]));
    await runCycle(repo, { transcribe: async () => '小林负责测试。' }, { lane: 'audio' });
    await repo.change(record.id, current => requestMinutes(current, { mode: 'model' }));
    const cycle = runCycle(repo, {}, { lane: 'minutes' });
    await sent;
    const current = await repo.get(record.id), segment = current.segments[0];
    await repo.change(record.id, r => editSegment(r, segment.id, { revision: segment.revision, text: '小陈负责测试。' }));
    revisionWork(); await cycle;
    assert.equal((await repo.get(record.id)).minutes, null);
  }, async (body, res) => {
    resolveSent(); await new Promise(resolve => { revisionWork = resolve; });
    const ref = JSON.parse(body.input.at(-1).content.at(-1).text).transcript[0];
    const text = JSON.stringify({ title: '旧纪要', sections: [{ heading: '事项', items: [{ text: ref.text, evidence: [{ segmentId: ref.id, revision: ref.revision }] }] }] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`);
  });
});


test('Doubao settings connectivity test sends synthetic audio', async () => fixture(async (_repo, config, requests) => {
  const result = await testDoubaoAudio(config);
  assert.equal(result.ok, true);
  const audio = requests[0].input[0].content[0];
  assert.equal(audio.type, 'input_audio');
  assert.ok(audio.audio_url.startsWith('data:audio/wav;base64,'));
}, (_body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ output_text: '{"ok":true}' })); }));


test('Doubao resumes using the frozen job model after settings change', async () => fixture(async (repo, config, requests) => {
  const { record, source } = await recorded(repo, config), job = { ...jobFor(record, source), modelVersion: 'doubao-audio:original-model' };
  const result = await generateDoubaoAudioMinutes(repo, record.id, job, { ...config, LLM_MODEL: 'new-model' });
  assert.equal(requests[0].model, 'original-model');
  assert.equal(result.runtime.model, 'original-model');
}));

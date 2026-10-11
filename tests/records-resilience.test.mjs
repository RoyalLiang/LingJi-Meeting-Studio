import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { createRecord, addSource, acknowledge, seal, requestMinutes, emit, digest } from '../packages/records/src/record.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'tts-resilience-')), repo = await createRepository({ root, databaseUrl: '' });
  try { await fn(repo); } finally { await repo.close(); await rm(root, { recursive: true }); }
}
async function withAudio(repo) {
  const r = createRecord('owner'), s = addSource(r, { kind: 'microphone' }), bytes = Buffer.alloc(3200);
  const object = await repo.putAudio(r.id, bytes);
  acknowledge(r, { sourceId: s.id, epoch: s.epoch, sequence: 0, sampleOffset: 0, sampleCount: 1600, sampleRate: 16000, ...object });
  seal(r, [{ sourceId: s.id, epoch: s.epoch, lastSequence: 0 }]); await repo.insert(r); return r;
}
test('deletion fences a provider already in flight and removes physical objects', () => fixture(async repo => {
  const r = await withAudio(repo);
  await runCycle(repo, { transcribe: async () => { await repo.change(r.id, current => { current.deleted = true; current.generation++; current.segments = []; current.jobs = []; }); return 'late provider text'; } });
  assert.equal((await repo.get(r.id)).segments.length, 0); await runCycle(repo);
  await assert.rejects(repo.readAudio(r.chunks[0].object), /ENOENT/);
}));
test('worker retries bounded ASR failures and never finalizes untranscribed audio', () => fixture(async repo => {
  const r = await withAudio(repo);
  await runCycle(repo, { transcribe: async () => { throw new Error('provider down'); } });
  const saved = await repo.get(r.id); assert.equal(saved.capture, 'sealed'); assert.equal(saved.chunks[0].attempts, 1); assert.equal(saved.transcription, 'blocked');
  await repo.change(r.id, value => { value.chunks[0].retryAt = 0; });
  await runCycle(repo, { transcribe: async () => '恢复后识别' });
  assert.equal((await repo.get(r.id)).capture, 'completed');
}));
test('minutes worker preserves concurrent human revisions', () => fixture(async repo => {
  const r = await withAudio(repo); await runCycle(repo, { transcribe: async () => '讨论内容' });
  await repo.change(r.id, value => requestMinutes(value));
  await runCycle(repo, { minutes: async job => {
    await repo.change(r.id, value => { value.minutesRevision++; value.minutes = { title: 'human edit' }; });
    return { title: 'late AI', sections: [{ heading: '总结', items: [{ text: '讨论内容', evidence: [{ segmentId: job.snapshot[0].id, revision: 1 }] }] }] };
  } });
  const current = await repo.get(r.id); assert.equal(current.minutes.title, 'human edit'); assert.equal(current.jobs[0].status, 'stale');
}));
test('unprocessed temporary audio expires even when capture never sealed', () => fixture(async repo => {
  const r = await withAudio(repo); await repo.change(r.id, value => { value.capture = 'recording'; value.chunks[0].acceptedAt = Date.now() - 86400001; });
  let called = false; await runCycle(repo, { transcribe: async () => { called = true; return 'unexpected'; } });
  assert.equal(called, false); assert.equal((await repo.get(r.id)).chunks[0].expired, true);
  await assert.rejects(repo.readAudio(r.chunks[0].object), /ENOENT/);
}));
test('AudioWorklet resamples to PCM16 and flushes final short chunk', async () => {
  const messages = []; let Processor;
  const context = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
    sampleRate: 48000, registerProcessor: (_name, value) => { Processor = value; } };
  vm.runInNewContext(await readFile(new URL('../apps/web/public/audio-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  for (let frame = 0; frame < 1125; frame++) { const values = Float32Array.from({ length: 128 }, (_, i) => Math.sin((frame * 128 + i) * Math.PI * 2 * 440 / 48000) * .5); processor.process([[values]]); }
  processor.port.onmessage({ data: { type: 'flush' } }); const pcm = messages.filter(m => m.type === 'pcm');
  assert.equal(pcm.length, 2); assert.equal(pcm[0].buffer.byteLength, 64000); assert.equal(pcm[1].buffer.byteLength, 32000);
  assert.ok(messages.some(m => m.type === 'meter' && m.value > .1)); assert.equal(messages.at(-1).type, 'flushed');
});
test('SSE delivers committed event IDs, expired cursor reset, and share revoke', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-sse-')); const app = await createRecordServer({ root, databaseUrl: '', port: 0 }); const address = await app.start();
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    const registered = await fetch(base + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sse@example.test', password: 'sse-test-long-password' }) });
    const user = await registered.json(), headers = { Cookie: registered.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf, 'Content-Type': 'application/json' };
    const r = createRecord(`user:${digest('sse@example.test')}`); r.capture = 'completed';
    r.minutes = { title: 'shared', sections: [{ heading: 'summary', items: [{ text: 'visible', evidence: [{ segmentId: 'public', revision: 1 }] }] }], actions: [], evidenceSnapshot: [{ id: 'public', revision: 1, text: 'visible' }, { id: 'private', revision: 1, text: 'private' }] };
    for (let i = 0; i < 1002; i++) emit(r, 'test'); await app.repo.insert(r);
    const abort = new AbortController(); const stream = await fetch(base + `/records/${r.id}/events?after=0`, { headers, signal: abort.signal });
    const reader = stream.body.getReader(); let output = '';
    while (!output.includes('event: reset')) { const chunk = await reader.read(); output += new TextDecoder().decode(chunk.value); }
    assert.match(output, /event: reset/); abort.abort();
    const shareRes = await fetch(base + `/records/${r.id}/shares`, { method: 'POST', headers, body: '{}' }); const share = await shareRes.json();
    const publicData = await (await fetch(base + `/shared/${share.token}`)).json(); assert.equal(publicData.minutes.evidenceSnapshot.length, 1);
    assert.equal(publicData.minutes.evidenceSnapshot[0].text, 'visible');
    await fetch(base + `/records/${r.id}/shares/${share.id}`, { method: 'DELETE', headers });
    assert.equal((await fetch(base + `/shared/${share.token}`)).status, 404);
  } finally { await app.stop(); await rm(root, { recursive: true }); }
});

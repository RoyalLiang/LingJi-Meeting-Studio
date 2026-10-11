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
import { createS3Objects } from '../services/records/src/s3.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'tts-resilience-')), repo = await createRepository({ root, databaseUrl: '' });
  try { await fn(repo); } finally { await repo.close(); await rm(root, { recursive: true }); }
}
async function withAudio(repo) {
  const r = createRecord('owner'), s = addSource(r, { kind: 'microphone' }), bytes = Buffer.alloc(3200);
  const object = await repo.putAudio(r.id, bytes);
  acknowledge(r, { sessionId: s.sessionId, sourceId: s.id, epoch: s.epoch, sequence: 0, sampleOffset: 0, sampleCount: 1600, sampleRate: 16000, ...object });
  seal(r, [{ sessionId: s.sessionId, sourceId: s.id, epoch: s.epoch, lastSequence: 0 }]); await repo.insert(r); return r;
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
test('idle records are scheduled in the future instead of rewriting every poll', () => fixture(async repo => {
  const r = createRecord('idle-owner'); await repo.insert(r); await runCycle(repo);
  assert.equal((await repo.listWork()).length, 0);
  const before = await repo.get(r.id); await runCycle(repo); assert.deepEqual(await repo.get(r.id), before);
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
    r.minutes.revision = 1; r.minutesRevision = 1; r.minutesHistory = [];
    await app.repo.change(r.id, current => { current.minutes = r.minutes; current.minutesRevision = 1; });
    const revised = { ...r.minutes, title: 'human revision' };
    assert.equal((await fetch(base + `/records/${r.id}/minutes`, { method: 'PATCH', headers, body: JSON.stringify({ revision: 1, minutes: revised }) })).status, 200);
    const oldVersion = await (await fetch(base + `/records/${r.id}/minutes/versions/1`, { headers })).json();
    assert.equal(oldVersion.title, 'shared');
    assert.equal((await app.repo.get(r.id)).minutes.title, 'human revision');
    const audio = await withAudio(app.repo);
    await app.repo.change(audio.id, current => { current.owner = r.owner; current.retainAudio = true; current.capture = 'completed'; current.chunks[0].state = 'done'; });
    const wav = await fetch(base + `/records/${audio.id}/audio/${audio.sources[0].id}`, { headers: { ...headers, Range: 'bytes=0-43' } });
    assert.equal(wav.status, 206); const header = Buffer.from(await wav.arrayBuffer()); assert.equal(header.length, 44); assert.equal(header.toString('ascii', 0, 4), 'RIFF');
    assert.equal(header.readUInt32LE(40), 3200);
  } finally { await app.stop(); await rm(root, { recursive: true }); }
});
test('S3 adapter checks immutable objects and scopes cleanup to one record prefix', async () => {
  const objects = new Map(); const calls = [];
  const client = { async send(command) {
    calls.push(command); const input = command.input;
    switch (command.constructor.name) {
      case 'GetBucketVersioningCommand': return {};
      case 'PutObjectCommand':
        if (objects.has(input.Key)) { const e = new Error('exists'); e.$metadata = { httpStatusCode: 412 }; throw e; }
        objects.set(input.Key, input.Body); return {};
      case 'GetObjectCommand': return { Body: { transformToByteArray: async () => objects.get(input.Key) } };
      case 'ListObjectsV2Command': return { Contents: [...objects.keys()].filter(k => k.startsWith(input.Prefix)).map(Key => ({ Key, LastModified: new Date(0) })) };
      case 'DeleteObjectsCommand': input.Delete.Objects.forEach(item => objects.delete(item.Key)); return {};
      default: throw new Error('unexpected command');
    }
  } };
  const store = await createS3Objects({ bucket: 'test-only', client }), id = createRecord('test').id;
  const result = await store.put(id, Buffer.from('pcm')); await store.put(id, Buffer.from('pcm'));
  assert.equal(objects.size, 1); assert.deepEqual(await store.read(result.object), Buffer.from('pcm'));
  assert.equal(calls.find(c => c.constructor.name === 'PutObjectCommand').input.IfNoneMatch, '*');
  await store.clean(id); assert.equal(objects.size, 0);
  assert.match(calls.find(c => c.constructor.name === 'ListObjectsV2Command').input.Prefix, new RegExp(`^meeting-audio/${id}/$`));
  await assert.rejects(createS3Objects({ bucket: 'versioned', client: { send: async () => ({ Status: 'Enabled' }) } }), /versioning_disabled/);
});

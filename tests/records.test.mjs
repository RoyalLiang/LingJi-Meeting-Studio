import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecord, addSource, acknowledge, seal, digest, commitTranscript, editSegment, requestMinutes, commitMinutes } from '../packages/records/src/record.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { runCycle } from '../services/records/src/worker.mjs';

const audio = (source, sequence, bytes = Buffer.alloc(3200)) => ({ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence,
  sampleOffset: sequence * 1600, sampleCount: 1600, sampleRate: 16000, digest: digest(bytes), object: 'test' });
test('durable identity, missing ranges, seal repair and finalization barrier', () => {
  const r = createRecord('a'), s = addSource(r, { kind: 'microphone' });
  assert.deepEqual(acknowledge(r, audio(s, 1)).missing, [0]);
  seal(r, [{ sessionId: s.sessionId, sourceId: s.id, epoch: s.epoch, lastSequence: 1 }]); assert.equal(r.capture, 'sealed');
  assert.equal(acknowledge(r, audio(s, 0)).watermark, 1);
  const count = r.chunks.length; acknowledge(r, audio(s, 0)); assert.equal(r.chunks.length, count);
  assert.throws(() => acknowledge(r, { ...audio(s, 0), digest: 'different' }), /audio_identity_conflict/);
  assert.throws(() => acknowledge(r, audio(s, 2)), /outside_sealed_manifest/);
  commitTranscript(r, r.chunks[0].key, '第二句', r.generation); assert.equal(r.capture, 'sealed');
  commitTranscript(r, r.chunks[1].key, '第一句', r.generation); assert.equal(r.capture, 'completed');
});
test('minutes preserve transcript evidence and fence stale results and human edits', () => {
  const r = createRecord('a'), s = addSource(r, { kind: 'microphone' }); acknowledge(r, audio(s, 0));
  commitTranscript(r, r.chunks[0].key, '明天评审', r.generation); seal(r, [{ sessionId: s.sessionId, sourceId: s.id, epoch: s.epoch, lastSequence: 0 }]);
  const job = requestMinutes(r); job.fence = 'one';
  const result = { title: '评审', sections: [{ heading: '决定', items: [{ text: '明天评审', evidence: [{ segmentId: r.segments[0].id, revision: 1 }] }] }], actions: [] };
  assert.throws(() => commitMinutes(r, job.id, result, 'two'), /stale_job/);
  editSegment(r, r.segments[0].id, { revision: 1, text: '后天评审', speaker: '主持人' });
  commitMinutes(r, job.id, result, 'one'); assert.equal(job.status, 'stale'); assert.equal(r.minutes, null);
  const fresh = requestMinutes(r); fresh.fence = 'new'; result.sections[0].items[0].evidence[0].revision = 2;
  commitMinutes(r, fresh.id, result, 'new'); assert.equal(r.minutes.transcriptRevision, 2);
  assert.throws(() => editSegment(r, r.segments[0].id, { revision: 1, text: 'old' }), /revision_conflict/);
});
test('SQLite restart preserves acknowledged audio and atomic rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-records-')); let repo = await createRepository({ root, databaseUrl: '' });
  try {
    const r = createRecord('owner'); const source = addSource(r, { kind: 'microphone' }); await repo.insert(r);
    const bytes = Buffer.alloc(3200, 5), object = await repo.putAudio(r.id, bytes);
    await repo.change(r.id, record => acknowledge(record, { ...audio(source, 0, bytes), ...object }));
    await assert.rejects(repo.change(r.id, record => { record.title = 'not committed'; throw new Error('rollback'); }));
    await repo.close(); repo = await createRepository({ root, databaseUrl: '' });
    assert.equal((await repo.get(r.id)).sources[0].watermark, 0);
    assert.equal((await repo.get(r.id)).title, '未命名会议');
    assert.deepEqual(await repo.readAudio(object.object), bytes);
    await runCycle(repo, { transcribe: async () => '持久化之后的转录' });
    assert.equal((await repo.get(r.id)).segments[0].text, '持久化之后的转录');
  } finally { await repo.close(); await rm(root, { recursive: true }); }
});
test('HTTP authentication, CSRF, owner isolation, text import and deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-http-')); const app = await createRecordServer({ root, databaseUrl: '', port: 0 });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  async function call(path, options = {}) { const res = await fetch(base + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); return { res, data: await res.json() }; }
  try {
    assert.equal((await call('/api/records')).res.status, 401);
    const login = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'one@example.com', password: 'long-password' }) });
    const headers = { Cookie: login.res.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': login.data.csrf };
    assert.equal((await call('/api/records', { method: 'POST', headers: { Cookie: headers.Cookie }, body: '{}' })).res.status, 403);
    const created = await call('/api/records', { method: 'POST', headers, body: JSON.stringify({ title: '会议 A' }) }); assert.equal(created.res.status, 201);
    const id = created.data.id;
    const imported = await call(`/api/records/${id}/import-text`, { method: 'POST', headers, body: JSON.stringify({ text: '用户说：后天发版。\n主持人：先验证回归。' }) });
    assert.equal(imported.data.segments.length, 2); assert.equal(imported.data.capture, 'completed');
    const other = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'two@example.com', password: 'long-password' }) });
    assert.equal((await call(`/api/records/${id}`, { headers: { Cookie: other.res.headers.get('set-cookie').split(';')[0] } })).res.status, 404);
    assert.equal((await call(`/api/records/${id}`, { method: 'DELETE', headers })).data.deleted, true);
    assert.equal((await call(`/api/records/${id}`, { headers })).res.status, 410);
    await runCycle(app.repo); assert.equal((await app.repo.get(id)).cleanup, 'completed');
  } finally { await app.stop(); await rm(root, { recursive: true }); }
});

test('manual restart fences an interrupted minutes job without weakening finalization', () => {
  const record = createRecord('restart-owner');
  record.capture = 'completed';
  record.transcriptRevision = 1;
  record.segments = [{id:'restart-segment',revision:1,text:'先完成评审，再安排上线。',startMs:0,endMs:2000,sourceId:'mic'}];
  const old = requestMinutes(record);
  old.status = 'running'; old.fence = 'old-worker'; old.lease = Date.now() + 60000;
  const next = requestMinutes(record, {retry:true});
  assert.notEqual(next.id, old.id);
  assert.equal(old.status, 'cancelled');
  assert.equal(old.fence, null);
  assert.throws(() => commitMinutes(record, old.id, {}, 'old-worker'), /stale_job/);
  assert.equal(next.status, 'queued');
  record.capture = 'paused';
  assert.throws(() => requestMinutes(record, {retry:true}), /record_not_finalized/);
  const live = requestMinutes(record, {scope:'live',retry:true});
  assert.equal(live.scope, 'live');
  assert.equal(next.status, 'cancelled');
});

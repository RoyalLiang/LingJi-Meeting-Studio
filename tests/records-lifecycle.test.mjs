import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as records from '../packages/records/src/record.mjs';
import { commitSpeakerTurns, finishSpeakerSource, updateTranscriptPreview } from '../packages/records/src/speakers.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';

const chunk = (s, sequence = 0) => ({ sessionId: s.sessionId, sourceId: s.id, epoch: s.epoch, sequence,
  sampleOffset: sequence * 16000, sampleCount: 16000, sampleRate: 16000, digest: `digest-${sequence}`, object: 'fixture' });
const manifest = r => r.sources.map(s => ({ sourceId: s.id, epoch: s.epoch, lastSequence: s.lastSequence ?? s.watermark }));

test('new recordings retain original audio by default while explicit opt-out stays compatible', () => {
  assert.equal(records.createRecord('fixture').retainAudio,true);
  assert.equal(records.createRecord('fixture',{retainAudio:false}).retainAudio,false);
});

test('completed unnamed meetings derive a keyword title and validated AI titles can refine it', () => {
  const r=records.createRecord('fixture'),s=records.addSource(r,{kind:'microphone'});
  records.acknowledge(r,chunk(s));records.seal(r,manifest(r));
  assert.equal(r.title,'未命名会议','wait for the durable transcript drain');
  records.commitTranscript(r,r.chunks[0].key,'今天讨论项目上线计划。项目上线需要完成回归测试。',r.generation);
  assert.notEqual(r.title,'未命名会议');assert.match(r.title,/项目|上线|回归/);
  const job=records.requestMinutes(r,{mode:'model'});job.fence='fixture';
  records.commitMinutes(r,job.id,{title:'项目上线与回归计划',sections:[{heading:'计划',items:[{text:'讨论上线计划',evidence:[{segmentId:r.segments[0].id,revision:1}]}]}]},'fixture');
  assert.equal(r.title,'项目上线与回归计划');
});

test('automatic titles protect user titles, manual minutes and empty recordings', () => {
  for(const title of ['自定义评审','未命名会议']) {
    const r=records.createRecord('fixture',{title}),s=records.addSource(r,{kind:'microphone'});records.acknowledge(r,chunk(s));
    records.commitTranscript(r,r.chunks[0].key,'项目上线需要完成回归测试。',r.generation);records.seal(r,manifest(r));
    assert.equal(r.title,title);
  }
  const empty=records.createRecord('fixture');records.seal(empty,[]);assert.equal(empty.title,'未命名会议');
  const r=records.createRecord('fixture');r.capture='completed';r.segments=[{id:'s1',revision:1,text:'项目上线',speaker:'',startMs:0,endMs:1000}];r.transcriptRevision=1;
  const job=records.requestMinutes(r,{mode:'model'});job.fence='fixture';r.title='用户在模型运行时补填';r.titleEdited=true;
  records.commitMinutes(r,job.id,{title:'后台建议名',sections:[{heading:'安排',items:[{text:'项目上线',evidence:[{segmentId:'s1',revision:1}]}]}]},'fixture');
  assert.equal(r.title,'用户在模型运行时补填');
});

test('default meeting name follows validated live minutes before the final transcript drains',()=>{
  const r=records.createRecord('fixture'),s=records.addSource(r,{kind:'microphone'});
  records.acknowledge(r,chunk(s));records.commitTranscript(r,r.chunks[0].key,'讨论发布计划',r.generation);
  const job=records.requestMinutes(r,{mode:'model',scope:'live'});job.fence='fixture';
  records.commitMinutes(r,job.id,{title:'产品发布计划',sections:[{heading:'发布',items:[{text:'讨论发布',evidence:[{segmentId:r.segments[0].id,revision:1}]}]}]},'fixture');
  assert.equal(r.title,r.liveMinutes.title);
  records.seal(r,manifest(r));assert.equal(r.title,'产品发布计划');
});

test('an ended meeting cannot silently accept another recording', () => {
  const r = records.createRecord('fixture'), s = records.addSource(r, { kind: 'microphone' });
  records.seal(r, manifest(r));
  assert.equal(r.capture, 'completed');
  assert.throws(() => records.addSource(r, { kind: 'microphone' }), /record_completed/);
  assert.equal(r.sources.length, 1);
  assert.equal(s.stopped, true);
});

test('pause preserves the meeting, resumed parallel sources share a contiguous timeline', () => {
  const r = records.createRecord('fixture'), a = records.addSource(r, { kind: 'microphone' }), b = records.addSource(r, { kind: 'display' });
  records.acknowledge(r, chunk(a)); records.acknowledge(r, chunk(b)); records.acknowledge(r, chunk(b, 1));
  records.pause(r, manifest(r));
  assert.equal(r.capture, 'paused');
  assert.ok(r.sources.every(s => s.stopped));
  const resumed = records.addSource(r, { kind: 'microphone' }), remote = records.addSource(r, { kind: 'display' });
  assert.notEqual(resumed.sessionId, a.sessionId);
  assert.equal(remote.sessionId, resumed.sessionId);
  assert.equal(resumed.timelineOffsetMs, 2000);
  assert.equal(remote.timelineOffsetMs, 2000);
  records.acknowledge(r, chunk(resumed));
  records.commitTranscript(r, r.chunks.at(-1).key, '继续讨论', r.generation);
  assert.equal(r.segments.at(-1).startMs, 2000);
  assert.equal(r.segments.at(-1).endMs, 3000);
  records.pause(r, manifest(r));
  const third = records.addSource(r, { kind: 'microphone' });
  assert.equal(third.timelineOffsetMs, 3000);
});

test('paused manifests allow repair but block resume until durable tail is known', () => {
  const r = records.createRecord('fixture'), s = records.addSource(r, { kind: 'microphone' });
  records.pause(r, [{ sourceId: s.id, epoch: s.epoch, lastSequence: 0 }]);
  assert.throws(() => records.addSource(r, { kind: 'microphone' }), /pause_audio_pending/);
  records.acknowledge(r, chunk(s)); records.acknowledge(r, chunk(s));
  assert.equal(r.chunks.length, 1);
  assert.throws(() => records.acknowledge(r, chunk(s, 1)), /outside_sealed_manifest/);
  assert.equal(records.addSource(r, { kind: 'microphone' }).timelineOffsetMs, 1000);
});

test('an invalid pause manifest does not partially stop a multi-source capture', () => {
  const r = records.createRecord('fixture'), a = records.addSource(r, { kind: 'microphone' }), b = records.addSource(r, { kind: 'display' });
  assert.throws(() => records.pause(r, [{ sourceId: a.id, epoch: a.epoch, lastSequence: -1 },
    { sourceId: b.id, epoch: 'wrong-epoch', lastSequence: -1 }]), /invalid_manifest/);
  assert.equal(r.capture, 'recording');
  assert.ok(r.sources.every(s => !s.stopped && s.lastSequence === null));
  assert.equal(r.sessions.at(-1).status, 'recording');
});

test('ASR completion after pause does not end the meeting; finishing remains a drain barrier', () => {
  const r = records.createRecord('fixture'), s = records.addSource(r, { kind: 'microphone' });
  records.acknowledge(r, chunk(s)); s.asr = { fence: 'fixture', state: 'running', ended: true, speakerMap: {}, mayAllocate: true };
  records.pause(r, manifest(r));
  assert.equal(finishSpeakerSource(r, s.id, 'fixture', r.generation), true);
  assert.equal(r.capture, 'paused');
  const cursor = r.cursor; records.pause(r, manifest(r)); assert.equal(r.cursor, cursor);
  records.seal(r, manifest(r)); assert.equal(r.capture, 'completed');
  assert.throws(() => records.pause(r, manifest(r)), /record_completed/);
});

test('speaker replay, preview and edits respect resumed source offsets', () => {
  const r = records.createRecord('fixture'), first = records.addSource(r, { kind: 'microphone' });
  records.acknowledge(r, chunk(first)); records.pause(r, manifest(r));
  const s = records.addSource(r, { kind: 'microphone' }); records.acknowledge(r, chunk(s));
  s.asr = { fence: 'fixture', state: 'running', speakerMap: {}, mayAllocate: true };
  const turn = { text: '继续后的发言', startMs: 0, endMs: 900, speakerId: '0' };
  commitSpeakerTurns(r, s.id, 'fixture', [turn], r.generation);
  const segment = r.segments[0]; assert.equal(segment.startMs, 1000); assert.equal(segment.endMs, 1900);
  commitSpeakerTurns(r, s.id, 'fixture', [turn], r.generation); assert.equal(r.segments.length, 1); assert.equal(segment.revision, 1);
  updateTranscriptPreview(r, s.id, 'fixture', { text: '实时草稿', startMs: 50 }, {}, r.generation);
  assert.equal(s.asr.preview.startMs, 1050);
  records.editSegment(r, segment.id, { revision: 1, text: '人工校对', speaker: segment.speaker });
  commitSpeakerTurns(r, s.id, 'fixture', [{ ...turn, text: '后台修订' }], r.generation);
  assert.equal(segment.text, '人工校对');
});

test('HTTP quick record, persisted pause/resume, end and later title editing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-lifecycle-'));
  const app = await createRecordServer({ root, databaseUrl: '', port: 0 });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  let headers = { 'Content-Type': 'application/json' };
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  try {
    const auth = await call('/auth/register', 'POST', { email: 'workflow@example.test', password: 'fixture-password' });
    headers = { ...headers, Cookie: auth.cookie.split(';')[0], 'X-CSRF-Token': auth.data.csrf };
    const created = await call('/records', 'POST', {}), id = created.data.id;
    assert.equal(created.status, 201); assert.equal(created.data.title, '未命名会议');
    const first = (await call(`/records/${id}/sources`, 'POST', { kind: 'microphone' })).data;
    const sources = [{ sourceId: first.id, epoch: first.epoch, lastSequence: -1 }];
    assert.equal((await call(`/records/${id}/pause`, 'POST', { sources })).data.capture, 'paused');
    assert.equal((await call(`/records/${id}`)).data.capture, 'paused');
    const next = (await call(`/records/${id}/sources`, 'POST', { kind: 'display' })).data;
    assert.notEqual(next.sessionId, first.sessionId);
    sources.push({ sourceId: next.id, epoch: next.epoch, lastSequence: -1 });
    assert.equal((await call(`/records/${id}/seal`, 'POST', { sources })).data.capture, 'completed');
    assert.equal((await call(`/records/${id}/sources`, 'POST', { kind: 'microphone' })).data.error, 'record_completed');
    assert.equal((await call(`/records/${id}`, 'PATCH', { title: '会后补填标题' })).data.title, '会后补填标题');
    assert.notEqual((await call('/records', 'POST', {})).data.id, id);
  } finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
});

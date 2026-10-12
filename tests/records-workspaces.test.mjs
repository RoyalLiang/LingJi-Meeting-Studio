import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecord, addSource, acknowledge, pause } from '../packages/records/src/record.mjs';
import { createWorkspace, retainedRecords, workspaceOverview, meetingSeconds, analysisSnapshot, requestWorkspaceAnalysis, validateWorkspaceAnalysis, publicWorkspaceAnalysis, inputHash } from '../packages/records/src/workspaces.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { processWorkspaceAnalysis } from '../services/records/src/workspace-worker.mjs';

const example = (owner = 'one') => {
  const r = createRecord(owner); r.capture = 'completed'; r.segments = [{ id: 's1', revision: 1, text: '决定周五评审', sourceId: 'text-import', startMs: 0, endMs: 0, speaker: '' }]; r.transcriptRevision = 1;
  const evidence = [{ segmentId: 's1', revision: 1 }];
  r.minutesRevision = 1; r.minutes = { transcriptRevision: 1, topics: [{ title: '产品进展', summary: '确认评审安排', evidence }], sections: [{ heading: '进展', items: [{ text: '周五评审', evidence }] }], decisions: [{ text: '周五评审', evidence }], actions: [{ text: '准备材料', owner: '待确认', evidence }] }; return r;
};
const resultFor = snapshot => {
  const item = { text: '已确认评审安排；材料准备仍是行动候选。', evidence: snapshot.map(({ recordId, transcriptRevision, minutesRevision }) => ({ recordId, transcriptRevision, minutesRevision })) };
  return { summary: item, themes: [{ ...item, title: '产品进展' }], decisions: [item], actions: [item], questions: [] };
};
async function fixture(fn) { const root = await mkdtemp(join(tmpdir(), 'lingji-workspace-')); const repo = await createRepository({ root, databaseUrl: '' }); try { await fn(repo); } finally { await repo.close(); await rm(root, { recursive: true, force: true }); } }

test('workspace scopes preserve legacy inbox, ownership, deletion and retention', () => {
  const a = example(), b = example('two'), w = createWorkspace('one', { name: ' 项目讨论 ' }); b.workspaceId = w.id;
  assert.equal(w.name, '项目讨论'); assert.throws(() => createWorkspace('one', { name: ' ' }), /invalid_workspace/);
  const c = example(); c.workspaceId = w.id; const gone = example(); gone.deleted = true; const expired = example(); expired.deleteAt = new Date(0).toISOString();
  assert.deepEqual(retainedRecords([a, b, c, gone, expired], 'one', 'inbox').map(r => r.id), [a.id]);
  assert.equal(retainedRecords([a, b, c, gone, expired], 'one', w.id).length, 1);
  assert.equal(retainedRecords([a, b, c, gone, expired], 'one', 'all').length, 2);
});
test('meeting duration counts parallel sources once and resumed sessions contiguously', () => {
  const r = createRecord('one'), mic = addSource(r, { kind: 'microphone' }), display = addSource(r, { kind: 'display' });
  for (const source of [mic, display]) acknowledge(r, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 0, sampleOffset: 0, sampleCount: 32000, sampleRate: 16000, digest: 'fixture', object: 'fixture' });
  pause(r, r.sources.map(s => ({ sourceId: s.id, epoch: s.epoch, lastSequence: 0 })));
  const resumed = addSource(r, { kind: 'microphone' }); acknowledge(r, { sessionId: resumed.sessionId, sourceId: resumed.id, epoch: resumed.epoch, sequence: 0, sampleOffset: 0, sampleCount: 16000, sampleRate: 16000, digest: 'fixture', object: 'fixture' });
  assert.equal(meetingSeconds(r), 3); assert.equal(workspaceOverview([r]).totals.audioSeconds, 5);
});
test('overview groups exact topics, marks stale minutes and labels transcript excerpts', () => {
  const a = example(), b = example(); b.minutes.topics[0].title = ' 产品进展 '; b.transcriptRevision++;
  const c = example(); c.minutes = null;
  const view = workspaceOverview([a, b, c]); assert.equal(view.topics[0].meetings, 2); assert.equal(view.totals.withMinutes, 2); assert.equal(view.totals.staleMinutes, 1); assert.equal(view.totals.actions, 2);
  assert.ok(view.summaries.some(s => s.method === 'transcript-excerpt')); assert.equal(view.activity.length, 30); assert.equal(view.timezone, 'Asia/Shanghai');
});
test('bounded analysis snapshot and output reject invented record or version references', () => {
  const r = example(), incomplete = example(); incomplete.capture = 'paused';
  const { snapshot, coverage } = analysisSnapshot([r, incomplete], 500); assert.equal(coverage.available, 1); assert.equal(coverage.included, 1); assert.ok(coverage.characters <= 500);
  const output = resultFor(snapshot); assert.equal(validateWorkspaceAnalysis(output, snapshot).themes[0].title, '产品进展'); output.summary.evidence[0].transcriptRevision++;
  assert.throws(() => validateWorkspaceAnalysis(output, snapshot), /invalid_workspace_evidence/);
  const job = requestWorkspaceAnalysis('one', 'all', [r]); assert.equal(requestWorkspaceAnalysis('one', 'all', [r], job).runId, job.runId); r.title = '新标题'; assert.equal(publicWorkspaceAnalysis(job, [r]).status, 'stale');
});
test('bulk repository changes roll back all records and persist membership after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-archive-')); let repo = await createRepository({ root, databaseUrl: '' });
  try {
    const a = await repo.insert(example()), b = await repo.insert(example());
    await assert.rejects(repo.changeMany([a.id, b.id], values => { values[0].workspaceId = 'changed'; throw new Error('rollback'); }), /rollback/);
    assert.equal((await repo.get(a.id)).workspaceId, null);
    await repo.changeMany([a.id, b.id], values => { for (const r of values) r.workspaceId = 'saved'; });
    await repo.close(); repo = await createRepository({ root, databaseUrl: '' }); assert.equal((await repo.get(a.id)).workspaceId, 'saved'); assert.equal((await repo.get(b.id)).workspaceId, 'saved');
  } finally { await repo.close(); await rm(root, { recursive: true, force: true }); }
});
test('analysis streams previews, fences cancelled requests, and purges changed input', async () => fixture(async repo => {
  const r = await repo.insert(example()), job = await repo.insert(requestWorkspaceAnalysis('one', 'all', [r]));
  let proceed, started; const ready = new Promise(resolve => { started = resolve; }), release = new Promise(resolve => { proceed = resolve; });
  const running = processWorkspaceAnalysis(repo, {}, { completeJson: async (_messages, _config, { onDelta }) => { await onDelta('{"summary":{"text":"正在梳理', { firstTokenMs: 4 }); started(); await release; return resultFor(job.snapshot); } });
  await ready; assert.match((await repo.get(job.id)).preview, /正在梳理/); await repo.change(job.id, value => { value.status = 'cancelled'; value.fence = null; value.snapshot = []; }); proceed(); await running;
  assert.equal((await repo.get(job.id)).status, 'cancelled'); assert.equal((await repo.get(job.id)).result, null);
  await repo.change(job.id, value => Object.assign(value, requestWorkspaceAnalysis('one', 'all', [r])));
  await processWorkspaceAnalysis(repo, {}, { completeJson: async () => resultFor(job.snapshot) }); assert.equal((await repo.get(job.id)).status, 'completed');
  await repo.change(r.id, value => { value.deleted = true; }); await processWorkspaceAnalysis(repo, {}, {}); const stale = await repo.get(job.id); assert.equal(stale.status, 'stale'); assert.equal(stale.result, null); assert.deepEqual(stale.snapshot, []);
}));
test('HTTP directory create, filter, rename and atomic archive enforce ownership and recording boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-workspace-api-')), app = await createRecordServer({ root, databaseUrl: '', port: 0 }); const address = await app.start(), base = `http://127.0.0.1:${address.port}/api`; let headers = { 'Content-Type': 'application/json' };
  const call = async (path, method = 'GET', body) => { const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie') }; };
  try {
    const auth = await call('/auth/register', 'POST', { email: 'workspace@example.test', password: 'fixture-password' }); headers = { ...headers, Cookie: auth.cookie.split(';')[0], 'X-CSRF-Token': auth.data.csrf };
    const workspace = await call('/workspaces', 'POST', { name: '研发周会' }); assert.equal(workspace.status, 201); const wid = workspace.data.id;
    const first = (await call('/records', 'POST', {})).data, second = (await call('/records', 'POST', { workspaceId: wid })).data;
    assert.equal((await call('/records?workspace=inbox')).data.records.length, 1); assert.equal((await call(`/records?workspace=${wid}`)).data.records[0].id, second.id);
    const other = await app.repo.insert(example('foreign')); const rejected = await call('/workspaces/archive', 'POST', { recordIds: [first.id, other.id], workspaceId: wid }); assert.equal(rejected.status, 404); assert.equal((await app.repo.get(first.id)).workspaceId, null);
    assert.equal((await call('/workspaces/archive', 'POST', { recordIds: [first.id], workspaceId: wid })).status, 200); assert.equal((await call(`/workspaces/${wid}/overview`)).data.totals.meetings, 2);
    await call(`/workspaces/${wid}`, 'PATCH', { name: '产品讨论', description: '虚构测试' }); assert.equal((await call('/workspaces')).data.workspaces[0].name, '产品讨论');
    await call(`/records/${first.id}/sources`, 'POST', { kind: 'microphone' }); assert.equal((await call('/workspaces/archive', 'POST', { recordIds: [second.id, first.id] })).data.error, 'archive_recording'); assert.equal((await app.repo.get(second.id)).workspaceId, wid);
    assert.equal((await call(`/workspaces/${createWorkspace('foreign', { name: '私有' }).id}/overview`)).status, 404);
    assert.equal(inputHash([await app.repo.get(first.id)]).length, 64);
  } finally { await app.stop(); await rm(root, { recursive: true, force: true }); }
});

test('real Responses SSE deltas accumulate into a readable preview and cancellation aborts upstream', async () => fixture(async repo => {
  const { default: http } = await import('node:http'), { completeJson } = await import('../services/records/src/providers.mjs');
  const r = await repo.insert(example()), job = await repo.insert(requestWorkspaceAnalysis('one', 'all', [r]));
  let ready, disconnected, previewChunks = 0;
  const middle = new Promise(resolve => { ready = resolve; }), closed = new Promise(resolve => { disconnected = resolve; });
  const model = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; /* Consume fictional request. */ }
    res.on('close', disconnected); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const write = delta => res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
    write('{"summary":{"text":"'); await new Promise(resolve => setTimeout(resolve, 300)); write('连续的流式草稿');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    const config = { LLM_API_URL: `http://127.0.0.1:${model.address().port}/v1/responses`, LLM_PROTOCOL: 'responses', LLM_API_KEY: 'fixture-only', LLM_MODEL: 'fixture' };
    const running = processWorkspaceAnalysis(repo, config, { completeJson: (messages, env, options) => completeJson(messages, env, { ...options, onDelta: async (delta, runtime) => { await options.onDelta(delta, runtime); if (++previewChunks === 2) ready(); } }) });
    await middle; assert.equal((await repo.get(job.id)).preview, '{"summary":{"text":"连续的流式草稿');
    await repo.change(job.id, value => { value.status = 'cancelled'; value.fence = null; value.snapshot = []; value.preview = ''; });
    await running; await closed; assert.equal((await repo.get(job.id)).status, 'cancelled'); assert.equal((await repo.get(job.id)).result, null);
  } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
}));

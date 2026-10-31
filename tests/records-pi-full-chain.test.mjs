import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as message, fauxToolCall as call } from '@earendil-works/pi-ai/providers/faux';
import { createRecordServer } from '../services/records/src/server.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { digest } from '../packages/records/src/record.mjs';

// ASR/minutes are explicit deterministic fixtures; Pi executes its real tool loop and SQLite storage.
// The configured fallback points only at a closed loopback port, never a real provider.
test('HTTP audio to worker minutes/highlights to Pi preserves drain, evidence, persistence and human edits', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-pi-full-chain-'));
  const model = { provider: 'pi-full-chain-fixture', modelId: 'deterministic' };
  const fake = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }], tokensPerSecond: Infinity });
  const models = createModels(); models.setProvider(fake.provider);
  let app, base, headers, liveWork;
  const liveStarted = Promise.withResolvers(), releaseLive = Promise.withResolvers();
  const transcriptions = [], generations = [];
  const texts = ['决定周五评审，林负责准备材料。', '停止录音前补充：评审改为周一，林周日前提交材料。'];
  const providers = {
    transcribe: async (bytes, record, chunk) => {
      assert.equal(bytes.length, 3200); assert.equal(bytes[0], chunk.sequence + 1);
      assert.equal(record.sources.length, 1); transcriptions.push(chunk.sequence);
      return texts[chunk.sequence];
    },
    minutes: async job => {
      generations.push({ scope: job.scope, ids: job.snapshot.map(segment => segment.id) });
      if (job.scope === 'live') { liveStarted.resolve(); await releaseLive.promise; }
      const facts = job.snapshot.filter(segment => !segment.contextOnly).map(segment => ({
        text: segment.text, evidence: [{ segmentId: segment.id, revision: segment.revision }],
      }));
      return { title: job.scope === 'live' ? '会中评审安排' : '最终评审安排',
        sections: [{ heading: '决策与安排', items: facts }], highlights: facts,
        decisions: facts, actions: [{ ...facts.at(-1), owner: '林' }] };
    },
  };
  async function open() {
    app = await createRecordServer({ root, databaseUrl: '', port: 0, agentOptions: { models, model } });
    const address = await new Promise((resolve, reject) => {
      app.server.once('error', reject); app.start().then(resolve, reject);
    });
    base = `http://127.0.0.1:${address.port}/api`;
  }
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  async function ok(path, method = 'GET', body, status = 200) {
    const response = await request(path, method, body);
    assert.equal(response.status, status, JSON.stringify(response.body)); return response.body;
  }
  async function settled(id) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const task = await ok(`/agent/tasks/${id}`);
      if (['completed', 'failed', 'blocked', 'cancelled'].includes(task.status)) return task;
      await delay(10);
    }
    assert.fail('Pi task did not settle');
  }
  function assertEvidence(minutes, segments) {
    const allowed = new Set(segments.map(segment => `${segment.id}:${segment.revision}`));
    for (const item of [...minutes.highlights, ...minutes.sections.flatMap(section => section.items), ...minutes.decisions, ...minutes.actions]) {
      assert.ok(item.evidence.length > 0);
      for (const ref of item.evidence) assert.ok(allowed.has(`${ref.segmentId}:${ref.revision}`), JSON.stringify(ref));
    }
  }
  try {
    await writeFile(join(root, 'providers.json'), JSON.stringify({ LLM_API_URL: 'http://127.0.0.1:1/v1/chat/completions',
      LLM_PROTOCOL: 'chat-completions', LLM_API_KEY: 'isolated-chain-fixture', LLM_MODEL: 'isolated-chain-fixture' }));
    await open();
    const login = await request('/auth/register', 'POST', { email: 'full-chain@example.test', password: 'FullChainFixture2026!' });
    assert.equal(login.status, 200);
    // Registration must capture the HTTP cookie rather than bypass Record authentication.
    const auth = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'full-chain@example.test', password: 'FullChainFixture2026!' }) });
    assert.equal(auth.status, 200); const user = await auth.json();
    headers = { Cookie: auth.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf };
    let record = await ok('/records', 'POST', { title: '完整链路合成会议', autoMinutes: false }, 201);
    const id = record.id, source = await ok(`/records/${id}/sources`, 'POST', { kind: 'microphone', label: '合成 PCM' });
    async function upload(sequence) {
      const bytes = Buffer.alloc(3200, sequence + 1);
      const identity = { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence,
        sampleOffset: sequence * 1600, sampleCount: 1600, sampleRate: 16000, digest: digest(bytes) };
      const response = await fetch(base + `/records/${id}/audio`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Record-Audio': JSON.stringify(identity) }, body: bytes });
      const receipt = await response.json(); assert.equal(response.status, 200, JSON.stringify(receipt));
      assert.equal(receipt.durable, true); return receipt;
    }
    assert.equal((await upload(0)).watermark, 0); assert.equal((await upload(0)).watermark, 0);
    assert.equal((await app.repo.get(id)).chunks.length, 1);
    await runCycle(app.repo, providers, { lane: 'audio' });
    record = await ok(`/records/${id}`);
    assert.deepEqual(record.segments.map(segment => segment.text), [texts[0]]);
    assert.equal(record.transcriptRevision, 1); assert.deepEqual(transcriptions, [0]);

    await ok(`/records/${id}/automation`, 'PATCH', { enabled: true, intervalSeconds: 30 });
    // Advance only the persisted scheduling clock; leave the actual worker and pipeline intact.
    await app.repo.change(id, value => { value.autoMinutes.enabledAt = Date.now() - 31000; });
    liveWork = runCycle(app.repo, providers, { lane: 'minutes' });
    await Promise.race([liveStarted.promise, delay(5000, undefined, { ref: false }).then(() => assert.fail('automatic live job did not start'))]);
    record = await ok(`/records/${id}/seal`, 'POST', { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 1 }] });
    assert.equal(record.capture, 'sealed'); assert.equal(record.minutes, null);
    assert.deepEqual(record.audio[0].missing, [1]);
    assert.equal((await upload(1)).watermark, 1);
    await runCycle(app.repo, providers, { lane: 'audio' });
    record = await ok(`/records/${id}`);
    assert.equal(record.capture, 'completed'); assert.equal(record.transcription, 'ready');
    assert.deepEqual(record.segments.map(segment => segment.text), texts); assert.equal(record.transcriptRevision, 2);
    await runCycle(app.repo, providers, { lane: 'minutes' });
    assert.deepEqual(generations.map(job => job.scope), ['live'], 'final generation must join the running live job');
    releaseLive.resolve(); await liveWork;
    record = await ok(`/records/${id}`);
    assert.equal(record.liveMinutes.highlights.length, 1); assert.equal(record.liveMinutes.transcriptRevision, 1);
    assertEvidence(record.liveMinutes, record.segments);
    await runCycle(app.repo, providers, { lane: 'minutes' });
    record = await ok(`/records/${id}`);
    assert.deepEqual(generations.map(job => job.scope), ['live', 'final']);
    assert.equal(record.minutes.transcriptRevision, 2); assert.equal(record.minutes.highlights.length, 2);
    assert.ok(record.minutes.highlights.some(point => point.text.includes('评审改为周一')));
    assertEvidence(record.minutes, record.segments);
    assert.ok(record.jobs.every(job => job.status === 'completed')); assert.deepEqual(transcriptions, [0, 1]);
    const finalMinutes = structuredClone(record.minutes);
    await runCycle(app.repo, providers, { lane: 'minutes' });
    assert.equal(generations.length, 2, 'an unchanged final checkpoint must not regenerate');

    await app.stop(); app = undefined; await open();
    record = await ok(`/records/${id}`); assert.deepEqual(record.minutes, finalMinutes);
    assert.deepEqual(record.liveMinutes.highlights.map(point => point.text), [texts[0]]);
    record = await ok(`/records/${id}/minutes`, 'PATCH', { revision: record.minutesRevision, minutes: record.minutes });
    assert.equal(record.minutes.edited, true); assert.deepEqual(record.minutes.highlights, finalMinutes.highlights);
    const manual = { title: '人工核对后的评审安排', sections: [{ heading: '人工确认', items: [
      { text: '人工确认周一评审，林周日前提交材料。', evidence: finalMinutes.highlights[1].evidence },
    ] }], actions: [] };
    record = await ok(`/records/${id}/minutes`, 'PATCH', { revision: record.minutesRevision, minutes: manual });
    assert.equal(record.minutes.edited, true); assert.equal(record.minutes.highlights, undefined);
    assert.equal(record.minutes.topics, undefined); assert.deepEqual(record.minutes.decisions, []);
    const humanMinutes = structuredClone(record.minutes);
    await runCycle(app.repo, providers, { lane: 'minutes' });
    assert.equal(generations.length, 2); assert.deepEqual((await ok(`/records/${id}`)).minutes, humanMinutes);

    const evidence = { recordId: id, segmentId: record.segments[1].id, revision: record.segments[1].revision };
    const result = { summary: '独立复盘：按人工确认周一评审。', decisions: [{ text: '周一评审', evidence: [evidence] }], actions: [] };
    function responses(output) {
      return [message(call('read_selected_meeting', { recordId: id }), { stopReason: 'toolUse' }), context => {
        const tools = context.messages.filter(item => item.role === 'toolResult');
        assert.equal(tools.length, 1); assert.equal(tools[0].toolName, 'read_selected_meeting'); assert.equal(tools[0].isError, false);
        const snapshot = JSON.parse(tools[0].content.find(item => item.type === 'text').text);
        assert.equal(snapshot.recordId, id); assert.equal(snapshot.transcriptRevision, record.transcriptRevision);
        assert.deepEqual(snapshot.minutes, humanMinutes); assert.deepEqual(snapshot.segments.map(segment => segment.text), texts);
        assert.deepEqual(snapshot.segments.map(segment => [segment.id, segment.revision]), record.segments.map(segment => [segment.id, segment.revision]));
        return message(JSON.stringify(output));
      }];
    }
    fake.setResponses(responses(result));
    const input = { recordIds: [id], prompt: '复盘最终安排并引用停止前的尾段。', requestId: 'full-chain-review', scopeConfirmed: true };
    const [first, duplicate] = await Promise.all([ok('/agent/tasks', 'POST', input, 202), ok('/agent/tasks', 'POST', input, 202)]);
    assert.equal(first.id, duplicate.id);
    const completed = await settled(first.id);
    assert.equal(completed.status, 'completed', JSON.stringify(completed)); assert.equal(completed.stale, false);
    assert.deepEqual(completed.result, result); assert.equal(fake.state.callCount, 2);
    assert.deepEqual((await ok(`/records/${id}`)).minutes, humanMinutes);
    const fabricated = structuredClone(result); fabricated.decisions[0].evidence[0].revision++;
    fake.setResponses(responses(fabricated));
    const invalid = await ok('/agent/tasks', 'POST', { ...input, requestId: 'invalid-reference' }, 202);
    const rejected = await settled(invalid.id);
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.error, 'invalid_agent_output'); assert.equal(rejected.result, undefined);
    const callsBeforeReopen = fake.state.callCount;
    await app.stop(); app = undefined; await open();
    assert.deepEqual((await ok(`/agent/tasks/${first.id}`)).result, result);
    assert.equal(fake.state.callCount, callsBeforeReopen, 'reopening completed tasks must not call the model');
    assert.deepEqual((await ok(`/records/${id}`)).minutes, humanMinutes);
    assert.deepEqual((await ok(`/records/${id}`)).minuteVersions.map(version => version.revision), [1, 2, 3]);
  } finally {
    releaseLive.resolve(); await liveWork?.catch(() => {}); await app?.stop(); await rm(root, { recursive: true, force: true });
  }
});

// PROTOTYPE: real Pi scheduling, official faux model, synthetic meetings; never production data.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.version, 'v26.12.1');
const versions = {};
for (const name of ['chord', 'pi-ai', 'pi-durable']) {
  versions[name] = JSON.parse(await readFile(new URL('node_modules/@earendil-works/' + name + '/package.json', import.meta.url), 'utf8')).version;
  assert.equal(versions[name], '1.4.0');
}
let fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts++; throw new Error('fixture_network_disabled'); };
const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
const { createModels } = await import('@earendil-works/pi-ai/models');
const { Type } = await import('@earendil-works/pi-ai');
const { fauxProvider, fauxAssistantMessage: message, fauxToolCall: call } = await import('@earendil-works/pi-ai/providers/faux');
const { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, defineTask, section, AssistantEntry } = await import('@earendil-works/pi-durable');
const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
const gate = () => Promise.withResolvers();
const model = { provider: 'meeting-fixture', modelId: 'meeting-fixture' };
const results = [];
const reports = [];

async function open({ storage = new MemoryStorage(), extensions = [], settings = {}, now } = {}) {
  const fake = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }], tokensPerSecond: Infinity });
  const models = createModels(); models.setProvider(fake.provider);
  const registry = createRegistry(); for (const extension of extensions) registry.install(extension);
  const h = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false }, ...settings }, ...(now ? { now } : {}), onReport: report => reports.push(report.kind) }, ctx);
  const root = await h.root(ctx, { agent: { model } });
  return { h, root, fake, registry };
}
async function answer(root, submission) {
  const settled = await submission.wait(ctx);
  assert.equal(settled.status, 'done', JSON.stringify(settled));
  assert.equal(settled.type, 'input');
  const entry = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), ctx);
  assert.equal(entry.model[0].stopReason, 'stop');
  return entry.model[0].content.filter(item => item.type === 'text').map(item => item.text).join('');
}
function toolOutputs(context, names) {
  const messages = context.messages.filter(item => item.role === 'toolResult').slice(-names.length);
  assert.deepEqual(messages.map(item => item.toolName), names);
  return messages.map(item => { assert.equal(item.isError, false); return item.content.filter(part => part.type === 'text').map(part => part.text).join(''); });
}
async function check(name, layer, run) {
  const detail = await run(); const result = { name, layer, passed: true, ...detail };
  results.push(result); console.log(JSON.stringify(result));
}
const aborted = (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
const terminal = result => ({ status: 'terminal', outcome: { status: 'completed', result } });

function recoveryExtension(onFinish = () => {}) {
  const Job = defineTask({ name: 'meeting.recovery.v1', version: 1, initial: () => ({ phase: 'checkpoint' }),
    phases: {
      checkpoint: (task, runtime, context) => runtime.sleepUntil(1_001_000, { phase: 'finish', operationId: task.input.operationId }, context),
      finish: (task, runtime, context) => { onFinish(); return runtime.commit(() => terminal({ operationId: task.state.checkpoint.operationId }), context); },
    }, abort: aborted });
  return { Job, extension: defineExtension({ name: 'meeting.recovery-plugin@1', tasks: [Job] }) };
}

if (process.argv[2] === '--crash-worker') {
  const directory = process.argv[3], { Job, extension } = recoveryExtension();
  const { h, root } = await open({ storage: await openNodeSqliteStorage(join(directory, 'fixture.sqlite')), extensions: [extension], now: () => 1_000_000 });
  const id = await root.commit(tx => tx.createTask(Job, { operationId: 'synthetic-review-1' }, { ownership: { kind: 'conversation' } }), ctx);
  h.resume();
  for (;;) {
    const task = (await h.inspect(ctx)).tasks.find(item => item.record.id === id);
    if (task?.state.kind === 'sleeping') break;
    await delay(5);
  }
  await writeFile(join(directory, 'checkpoint.json'), JSON.stringify({ id }));
  process.stdout.write('CHECKPOINT_COMMITTED\n');
  await new Promise(() => {});
} else {
  await check('meeting_skill_and_citations', 'pi-native + explicit fixture host policy', async () => {
    const selected = new Map([
      ['meeting-a', { recordId: 'meeting-a', transcriptRevision: 3, minutesRevision: 7, segments: [{ id: 'a1', revision: 3, text: '决定周五进行产品复盘。' }] }],
      ['meeting-b', { recordId: 'meeting-b', transcriptRevision: 2, minutesRevision: 4, segments: [{ id: 'b1', revision: 2, text: '材料准备是待确认的行动候选。' }] }],
    ]);
    const frozen = structuredClone(selected), access = new Set(selected.keys());
    const reads = [], skill = '会议复盘Skill@1：结论必须带片段版本；行动只生成候选。';
    const finalizeDraft = draft => {
      assert.ok(Array.isArray(draft.evidence) && draft.evidence.length > 0, 'missing_citation');
      for (const ref of draft.evidence) assert.ok(frozen.get(ref.recordId)?.segments.some(segment => segment.id === ref.segmentId && segment.revision === ref.revision), 'invalid_citation');
      for (const ref of draft.evidence) assert.ok(access.has(ref.recordId) && selected.has(ref.recordId), 'access_revoked');
      const stale = [...frozen].some(([id, snapshot]) => selected.get(id)?.minutesRevision !== snapshot.minutesRevision || selected.get(id)?.transcriptRevision !== snapshot.transcriptRevision)
        || draft.evidence.some(ref => !selected.get(ref.recordId)?.segments.some(segment => segment.id === ref.segmentId && segment.revision === ref.revision));
      return { status: stale ? 'stale' : 'ready', draft: structuredClone(draft) };
    };
    const read = defineTool({ name: 'read_selected_meeting', description: 'Read only a selected synthetic meeting snapshot.', parameters: Type.Object({ recordId: Type.String() }), execute: async args => {
      const snapshot = frozen.get(args.recordId); if (!snapshot || !access.has(args.recordId)) throw new Error('record_scope_denied');
      reads.push(args.recordId); return { output: [{ type: 'text', text: JSON.stringify(snapshot) }] };
    } });
    const extension = defineExtension({ name: 'meeting-review@1', tools: [read], sections: [section('meeting-skill', () => skill)] });
    const { h, root, fake } = await open({ extensions: [extension] });
    try {
      const candidate = { text: '周五复盘；材料准备待确认。', evidence: [{ recordId: 'meeting-a', segmentId: 'a1', revision: 3 }, { recordId: 'meeting-b', segmentId: 'b1', revision: 2 }] };
      fake.setResponses([(context) => {
        assert.ok(JSON.stringify(context).includes(skill));
        assert.deepEqual(context.messages.flatMap(item => item.toolsAdded || []).map(tool => tool.name), ['read_selected_meeting']);
        return message([call(read.name, { recordId: 'meeting-a' }), call(read.name, { recordId: 'meeting-b' })], { stopReason: 'toolUse' });
      }, context => {
        const delivered = toolOutputs(context, [read.name, read.name]).map(text => JSON.parse(text)).sort((a, b) => a.recordId.localeCompare(b.recordId));
        assert.deepEqual(delivered, [...frozen.values()]); return message(JSON.stringify(candidate));
      }]);
      const draft = JSON.parse(await answer(root, await root.submit({ type: 'input', content: '复盘这两场合成会议。' }, ctx)));
      assert.equal(finalizeDraft(draft).status, 'ready');
      assert.throws(() => finalizeDraft({ ...draft, evidence: [{ recordId: 'meeting-a', segmentId: 'a1', revision: 999 }] }), /invalid_citation/);
      assert.throws(() => finalizeDraft({ ...draft, evidence: [] }), /missing_citation/);
      selected.get('meeting-a').transcriptRevision++; assert.equal(finalizeDraft(draft).status, 'stale'); selected.get('meeting-a').transcriptRevision--;
      selected.get('meeting-a').segments[0].revision++; assert.equal(finalizeDraft(draft).status, 'stale'); selected.get('meeting-a').segments[0].revision--;
      assert.deepEqual(reads.sort(), ['meeting-a', 'meeting-b']);
      selected.get('meeting-a').minutesRevision++; selected.get('meeting-a').humanMinutes = '人工修改后的纪要';
      const afterHumanEdit = structuredClone(selected);
      assert.equal(finalizeDraft(draft).status, 'stale'); assert.deepEqual(selected, afterHumanEdit);
      fake.setResponses([message(call(read.name, { recordId: 'meeting-c' }), { stopReason: 'toolUse' }), context => {
        assert.ok(JSON.stringify(context.messages).includes('record_scope_denied'));
        return message('拒绝读取未选会议。');
      }]);
      assert.equal(await answer(root, await root.submit({ type: 'input', content: '读取未选中的第三场会议。' }, ctx)), '拒绝读取未选会议。');
      access.delete('meeting-a');
      assert.throws(() => finalizeDraft(draft), /access_revoked/);
      fake.setResponses([message(call(read.name, { recordId: 'meeting-a' }), { stopReason: 'toolUse' }), context => {
        assert.ok(JSON.stringify(context.messages).includes('record_scope_denied')); return message('访问权已撤销。');
      }]);
      assert.equal(await answer(root, await root.submit({ type: 'input', content: '再次读取已撤权会议。' }, ctx)), '访问权已撤销。');
      assert.equal(reads.length, 2);
      return { selectedMeetings: 2, successfulToolResultsDelivered: 2, deniedOutOfScope: true, revokedAccessDenied: true, invalidAndEmptyCitationRejected: true, transcriptAndSegmentChangesStale: true, staleDraftProtectedByHost: true, codingTools: 0 };
    } finally { await h.close(ctx); }
  });

  await check('busy_queue_and_request_deduplication', 'pi-native', async () => {
    const { h, root, fake } = await open(); const entered = gate(), release = gate();
    try {
      fake.setResponses([async () => { entered.resolve(); await release.promise; return message('first'); }, message('second')]);
      const first = await root.submit({ type: 'input', content: '合成会议复盘一', requestId: 'meeting-run-1' }, ctx);
      await entered.promise;
      const again = await root.submit({ type: 'input', content: '合成会议复盘一', requestId: 'meeting-run-1' }, ctx);
      assert.equal(again.id, first.id);
      const second = await root.submit({ type: 'input', content: '合成会议复盘二', whenBusy: 'followUp' }, ctx);
      assert.equal(fake.state.callCount, 1);
      release.resolve(); assert.equal(await answer(root, first), 'first'); assert.equal(await answer(root, second), 'second');
      assert.equal(fake.state.callCount, 2);
      return { calls: 2, duplicateSubmissionReused: true, queuedWhileBusy: true };
    } finally { release.resolve(); await h.close(ctx); }
  });

  await check('tool_parallel_and_sequential_modes', 'pi-native; not a global agent quota', async () => {
    const peaks = {};
    for (const mode of ['parallel', 'sequential']) {
      let active = 0, peak = 0; const bothEntered = gate();
      const tool = defineTool({ name: 'read_fixture_reference', description: 'Synthetic reference lookup, not an MCP transport.', parameters: Type.Object({ id: Type.String() }), execute: async args => {
        active++; peak = Math.max(peak, active);
        if (mode === 'parallel') { if (active === 2) bothEntered.resolve(); await bothEntered.promise; } else await Promise.resolve();
        active--;
        return { output: [{ type: 'text', text: args.id }] };
      } });
      const { h, root, fake } = await open({ extensions: [defineExtension({ name: 'reference@1', tools: [tool] })], settings: { toolExecution: mode } });
      try {
        fake.setResponses([message([call(tool.name, { id: 'a' }), call(tool.name, { id: 'b' })], { stopReason: 'toolUse' }), context => {
          assert.deepEqual(toolOutputs(context, [tool.name, tool.name]).sort(), ['a', 'b']); return message('references read');
        }]);
        await answer(root, await root.submit({ type: 'input', content: '读取两份合成资料' }, ctx)); peaks[mode] = peak;
      } finally { await h.close(ctx); }
    }
    assert.deepEqual(peaks, { parallel: 2, sequential: 1 }); return peaks;
  });

  await check('parent_abort_propagates_to_subagent', 'pi-native', async () => {
    const started = gate(); let observedAbort = false, childId;
    const delegate = defineTool({ name: 'review_subagent', description: 'Delegate a synthetic meeting review.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
      childId = await api.commit(async tx => (await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })).id, context);
      const child = await api.conversation(childId, context);
      const settled = await (await child.submit({ type: 'input', content: '合成会议风险复核', requestId: 'child-review-1' }, context)).wait(context);
      return { output: [{ type: 'text', text: settled.status }] };
    } });
    const { h, root, fake } = await open({ extensions: [defineExtension({ name: 'meeting-delegate@1', tools: [delegate] })] });
    let graph;
    try {
      fake.setResponses([message(call(delegate.name, {}), { stopReason: 'toolUse' }), async (_context, options) => {
        started.resolve(); assert.ok(options.signal);
        await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
        observedAbort = true; return message('cancelled', { stopReason: 'aborted' });
      }]);
      const submitted = await root.submit({ type: 'input', content: '委派会议风险复核' }, ctx); await started.promise;
      graph = await h.taskGraph(ctx); const liveBefore = Object.keys(graph.value.tasks).length; assert.ok(liveBefore >= 3);
      await root.abort(ctx); const settled = await submitted.wait(ctx);
      assert.equal(settled.status, 'unanswered'); assert.equal(observedAbort, true);
      assert.equal((await h.inspect(ctx)).tasks.length, 0);
      return { childCreated: Boolean(childId), liveTasksBeforeAbort: liveBefore, childObservedAbort: true, parentStatus: settled.status, liveTasksAfterAbort: 0 };
    } finally { graph?.dispose(); await h.close(ctx); }
  });

  await check('noncooperative_plugin_requires_host_isolation', 'observed Pi boundary', async () => {
    const entered = gate(), release = gate(); let settled = false;
    const Job = defineTask({ name: 'meeting.stubborn.v1', version: 1, initial: () => ({ phase: 'run' }), phases: { run: async (_task, runtime, context) => {
      entered.resolve(); await release.promise; await runtime.commit(() => terminal(null), context);
    } }, abort: aborted });
    const { h, root } = await open({ extensions: [defineExtension({ name: 'stubborn@1', tasks: [Job] })] });
    try {
      const id = await root.commit(tx => tx.createTask(Job, {}, { ownership: { kind: 'conversation' } }), ctx); h.resume(); await entered.promise;
      const stop = h.abortTask(id, ctx).then(() => { settled = true; });
      await delay(30); assert.equal(settled, false);
      release.resolve(); await stop; const receipt = await h.waitForTask(id, ctx); assert.equal(receipt.state.outcome.status, 'aborted');
      return { cancellationIsCooperative: true, stopWaitedForPluginReturn: true, hardTimeoutProvidedByPi: false };
    } finally { release.resolve(); await h.close(ctx); }
  });

  await check('cooperative_deadline', 'host timer + Pi abort propagation', async () => {
    const { h, root, fake } = await open(); const entered = gate(); let timer, sawAbort = false;
    try {
      fake.setResponses([async (_context, options) => {
        entered.resolve(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        sawAbort = true; return message('deadline', { stopReason: 'aborted' });
      }]);
      const submission = await root.submit({ type: 'input', content: '有总时限的合成复盘' }, ctx); await entered.promise;
      const stopped = gate(); timer = setTimeout(() => root.abort(ctx).then(stopped.resolve, stopped.reject), 20);
      await stopped.promise; assert.equal((await submission.wait(ctx)).status, 'unanswered'); assert.equal(sawAbort, true);
      return { deadlineSuppliedByHost: true, cooperativeWorkStopped: true };
    } finally { clearTimeout(timer); await h.close(ctx); }
  });

  await check('plugin_version_pinning_and_missing_definition', 'Pi registry + explicit host version names', async () => {
    const make = version => {
      const Job = defineTask({ name: 'meeting.review.v' + version, version: 1, initial: () => ({ phase: 'run' }), phases: { run: (_task, runtime, context) => runtime.commit(() => terminal({ pluginVersion: version }), context) }, abort: aborted });
      return { Job, extension: defineExtension({ name: 'meeting-review@' + version, tasks: [Job] }) };
    };
    const directory = await mkdtemp(join(tmpdir(), 'PROTOTYPE-pi-version-'));
    const v1 = make(1), v2 = make(2); let h;
    try {
      let opened = await open({ storage: await openNodeSqliteStorage(join(directory, 'versions.sqlite')), extensions: [v1.extension] }); h = opened.h;
      const old = await opened.root.commit(tx => tx.createTask(v1.Job, {}, { ownership: { kind: 'conversation' } }), ctx);
      await h.close(ctx); h = undefined;
      opened = await open({ storage: await openNodeSqliteStorage(join(directory, 'versions.sqlite')), extensions: [v2.extension] }); h = opened.h;
      const { root, registry } = opened;
      const blocked = (await h.inspect(ctx)).tasks.find(item => item.record.id === old);
      assert.equal(blocked.state.kind, 'blocked'); assert.equal(blocked.state.reason, 'missing_task');
      registry.install(v1.extension);
      const fresh = await root.commit(tx => tx.createTask(v2.Job, {}, { ownership: { kind: 'conversation' } }), ctx);
      const [a, b] = await Promise.all([h.waitForTask(old, ctx), h.waitForTask(fresh, ctx)]);
      assert.equal(a.state.outcome.result.pluginVersion, 1); assert.equal(b.state.outcome.result.pluginVersion, 2);
      return { persistedAcrossReopen: true, missingOldVersion: 'blocked/missing_task', restoredOldVersion: 1, newTaskVersion: 2, versionNamingSuppliedByHost: true };
    } finally { await h?.close(ctx); await rm(directory, { recursive: true, force: true }); }
  });

  await check('sqlite_checkpoint_sigkill_resume', 'pi-native; virtual clock, no external side effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'PROTOTYPE-pi-meeting-')); let child, h;
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-worker', directory], { env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stderr.on('data', bytes => { errors += bytes; });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('checkpoint timeout: ' + errors)), 5000);
        child.once('error', reject); child.once('exit', () => { clearTimeout(timeout); if (!output.includes('CHECKPOINT_COMMITTED')) reject(new Error('worker exited before checkpoint: ' + errors)); });
        child.stdout.on('data', bytes => { output += bytes; if (output.includes('CHECKPOINT_COMMITTED')) { clearTimeout(timeout); resolve(); } });
      });
      const exit = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exit; assert.equal(signal, 'SIGKILL');
      const { id } = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8')); let finishes = 0;
      const { extension } = recoveryExtension(() => { finishes++; });
      ({ h } = await open({ storage: await openNodeSqliteStorage(join(directory, 'fixture.sqlite')), extensions: [extension], now: () => 1_001_001 }));
      h.resume(); const receipt = await h.waitForTask(id, ctx);
      assert.equal(receipt.state.outcome.status, 'completed'); assert.equal(receipt.state.outcome.result.operationId, 'synthetic-review-1'); assert.equal(finishes, 1);
      await h.close(ctx); h = undefined; finishes = 0;
      ({ h } = await open({ storage: await openNodeSqliteStorage(join(directory, 'fixture.sqlite')), extensions: [extension], now: () => 1_001_001 }));
      h.resume(); assert.equal((await h.waitForTask(id, ctx)).state.outcome.status, 'completed'); assert.equal(finishes, 0);
      return { killedWith: signal, resumedFromCommittedCheckpoint: true, completionNotReplayedOnReopen: true, powerLossTested: false };
    } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await h?.close(ctx); await rm(directory, { recursive: true, force: true }); }
  });

  assert.equal(fetchAttempts, 0);
  assert.deepEqual(reports, []);
  const evidence = { date: '2026-10-31', node: process.version, platform: process.platform, arch: process.arch, packages: versions,
    fixtureSourceSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    lockSha256: createHash('sha256').update(await readFile(new URL('package-lock.json', import.meta.url))).digest('hex'),
    officialFauxProvider: true, fixtureOnly: true, realMeetings: false, realProviders: false, mcpTransportTested: false, productionIntegrated: false, fetchAttempts, results, reports };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ passed: results.length, failed: 0, fetchAttempts }));
}

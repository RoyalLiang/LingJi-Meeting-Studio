// Synthetic isolated A/B benchmark. No .env, user data, real devices, or provider network calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.version, 'v26.12.1', 'Use pinned Node 26.12.1');
const candidate = resolve(fileURLToPath(new URL('..', import.meta.url)));
const samples = Number(process.env.PI_BENCH_SAMPLES || 12), providerDelayMs = 15;
assert.ok(Number.isInteger(samples) && samples >= 8 && samples <= 100);
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
};
if (process.argv[2] === '--probe') {
  const tree = resolve(process.argv[3]), mode = process.argv[4];
  // Explicit fixture configuration; never inherit provider/database credentials.
  for (const key of Object.keys(process.env)) if (/^(RECORD_|LLM_|ASR_|DOUBAO_|FUNASR_|OPENAI_|ANTHROPIC_)/.test(key)) delete process.env[key];
  process.env.RECORD_LEARNING_ENABLED = 'false';
  const importAt = performance.now();
  const load = path => import(pathToFileURL(join(tree, path)).href);
  const { createRepository } = await load('services/records/src/repository.mjs');
  const { createRecord, addSource, acknowledge, seal, digest, requestMinutes, commitMinutes } = await load('packages/records/src/record.mjs');
  const { runCycle } = await load('services/records/src/worker.mjs');
  const { runMinutesPipeline } = await load('services/records/src/minutes-pipeline.mjs');
  const { startDesktopBackend } = await load('services/records/src/desktop-backend.mjs');
  const moduleImportMs = performance.now() - importAt;
  const root = await mkdtemp(join(tmpdir(), 'pi-chain-benchmark-'));
  let repo, runtime, backend;
  try {
    repo = await createRepository({ root, databaseUrl: '', s3: { bucket: '' } });
    for (let i = 0; i < 30; i++) {
      const r = createRecord('owner', { title: `Synthetic history ${i}` });
      r.capture = 'completed'; r.transcription = 'completed'; r.transcriptRevision = 1;
      r.segments = Array.from({ length: 100 }, (_, n) => ({ id: `history-${i}-${n}`, revision: 1, startMs: n * 1000, endMs: n * 1000 + 900, text: 'Synthetic retained history only. '.repeat(12) }));
      await repo.insert(r);
    }
    await repo.close(); repo = undefined;
    const startup = [], health = []; let firstReadinessMs;
    for (let i = 0; i < 6; i++) {
      const start = performance.now(); backend = await startDesktopBackend({ root, workers: false });
      if (!i) firstReadinessMs = performance.now() - start;
      if (i) startup.push(performance.now() - start);
      for (let n = 0; n < 10; n++) {
        const at = performance.now(); const response = await fetch(`${backend.url}/api/health`);
        assert.equal(response.status, 200); await response.text();
        if (i) health.push(performance.now() - at);
      }
      await backend.stop(); backend = undefined;
    }
    repo = await createRepository({ root, databaseUrl: '', s3: { bucket: '' } });
    const sourceRecord = createRecord('owner', { title: 'Synthetic Pi evidence' });
    sourceRecord.capture = 'completed'; sourceRecord.transcriptRevision = 1;
    sourceRecord.segments = [{ id: 'pi-segment', revision: 1, startMs: 0, endMs: 1000, text: 'Decision: keep human minutes.' }];
    await repo.insert(sourceRecord);
    let piProviderCalls = 0, running = true, background;
    let fullRecordReads = 0; const realGet = repo.get.bind(repo);
    repo.get = (...args) => { fullRecordReads++; return realGet(...args); };
    if (mode !== 'baseline') {
      const { createMeetingAgentRuntime } = await load('services/records/src/meeting-agent.mjs');
      const { createModels } = await import(pathToFileURL(join(tree, 'node_modules/@earendil-works/pi-ai/dist/models.js')).href);
      const { fauxProvider, fauxAssistantMessage: message, fauxToolCall: call } = await import(pathToFileURL(join(tree, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href);
      const fake = fauxProvider({ provider: 'benchmark', models: [{ id: 'synthetic' }], tokensPerSecond: 0 });
      const result = { summary: 'Synthetic independent review', decisions: [{ text: 'Keep human minutes', evidence: [{ recordId: sourceRecord.id, segmentId: 'pi-segment', revision: 1 }] }], actions: [] };
      fake.setResponses(Array.from({ length: 400 }, (_, n) => async () => { piProviderCalls++; await delay(providerDelayMs); return n % 2 === 0 ? message(call('read_selected_meeting', { recordId: sourceRecord.id }), { stopReason: 'toolUse' }) : message(JSON.stringify(result)); }));
      const models = createModels(); models.setProvider(fake.provider);
      runtime = await createMeetingAgentRuntime({ repo, models, model: { provider: 'benchmark', modelId: 'synthetic' } });
      const once = async id => {
        const job = await runtime.request('owner', { recordIds: [sourceRecord.id], requestId: `benchmark-${id}`, prompt: 'Review selected evidence', scopeConfirmed: true });
        for (let n = 0; n < 1000; n++) {
          const task = await runtime.get('owner', job.id);
          if (task.status === 'completed') { assert.deepEqual(task.result, result); return; }
          assert.ok(!['failed', 'blocked', 'cancelled'].includes(task.status), JSON.stringify(task)); await delay(2);
        }
        assert.fail('Pi fixture did not settle');
      };
      await once('warmup');
      if (mode === 'loaded') background = (async () => { let n = 0; while (running) await once(n++); })();
    }
    const times = { pcmDurableAck: [], transcriptPersisted: [], minutesAndHighlightsPersisted: [], chain: [], providerWait: [], hostOverhead: [] };
    for (let i = 0; i < samples + 2; i++) {
      let providerWait = 0; const wait = async () => { const start = performance.now(); await delay(providerDelayMs); providerWait += performance.now() - start; };
      const chainAt = performance.now();
      const record = createRecord('owner', { title: `Synthetic chain ${i}` });
      const source = addSource(record, { kind: 'microphone' }); await repo.insert(record);
      const pcm = Buffer.alloc(3200, 5), ackAt = performance.now();
      const object = await repo.putAudio(record.id, pcm);
      await repo.change(record.id, r => acknowledge(r, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence: 0, sampleOffset: 0, sampleCount: 1600, sampleRate: 16000, digest: digest(pcm), ...object }));
      const ackMs = performance.now() - ackAt;
      assert.equal((await repo.get(record.id)).sources[0].watermark, 0);
      assert.deepEqual(await repo.readAudio(object.object), pcm);
      const asrAt = performance.now();
      await runCycle(repo, { transcribe: async () => { await wait(); return 'Synthetic decision: validate before release.'; } }, { lane: 'audio' });
      const transcribed = await repo.get(record.id);
      assert.equal(transcribed.segments[0].text, 'Synthetic decision: validate before release.');
      assert.equal(transcribed.chunks[0].state, 'done');
      const asrMs = performance.now() - asrAt;
      let claim; await repo.change(record.id, r => { seal(r, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 0 }]); const job = requestMinutes(r, { scope: 'final', modelVersion: 'deterministic-benchmark' }); job.status = 'running'; job.fence = `benchmark-${i}`; job.lease = Date.now() + 300000; claim = structuredClone(job); });
      const minutesAt = performance.now();
      const generated = await runMinutesPipeline(repo, record.id, claim, {}, async job => {
        await wait(); const evidence = job.snapshot.filter(s => !s.contextOnly).map(s => ({ segmentId: s.id, revision: s.revision }));
        return { title: 'Synthetic meeting', sections: [{ heading: 'Decision', items: [{ text: 'Validate before release.', evidence }] }], highlights: [{ text: 'Validate before release.', evidence }], actions: [], decisions: [], usageReported: false };
      });
      await repo.change(record.id, r => commitMinutes(r, claim.id, generated, claim.fence));
      const saved = await repo.get(record.id);
      assert.equal(saved.jobs.find(j => j.id === claim.id).status, 'completed');
      assert.equal(saved.minutes.highlights[0].text, 'Validate before release.');
      assert.equal(saved.minutes.highlights[0].evidence[0].segmentId, saved.segments[0].id);
      const minutesMs = performance.now() - minutesAt, chainMs = performance.now() - chainAt;
      if (i >= 2) for (const [key, value] of Object.entries({ pcmDurableAck: ackMs, transcriptPersisted: asrMs, minutesAndHighlightsPersisted: minutesMs, chain: chainMs, providerWait, hostOverhead: chainMs - providerWait })) times[key].push(value);
    }
    running = false; await background;
    const readStart = fullRecordReads;
    await delay(mode === 'baseline' ? 10 : 2200);
    const idleRetentionReads = fullRecordReads - readStart;
    console.log(JSON.stringify({ mode, node: process.version, samples, moduleImportMs, firstReadinessMs, startup: distribution(startup), health: distribution(health), timings: Object.fromEntries(Object.entries(times).map(([key, value]) => [key, distribution(value)])), providerDelayMs, piProviderCalls, idleRetentionReads, retentionObservationMs: mode === 'baseline' ? 10 : 2200, assertions: { pcmDurable: true, transcriptPersisted: true, minutesPersisted: true, highlightsCited: true }, scope: 'in-process durable PCM acknowledgement and actual pipeline persistence; HTTP health only; startup distributions exclude module import (reported separately) and native capture or real provider' }));
  } finally { await runtime?.close(); await backend?.stop(); await repo?.close(); await rm(root, { recursive: true, force: true }); }
} else {
  const evidence = resolve(process.argv[2] || join(candidate, '.agent-runtime/tasks/20261031-pi-chain-regression/benchmark'));
  await mkdir(evidence, { recursive: true });
  const baseline = join(evidence, 'baseline-2a8275d'); await mkdir(baseline, { recursive: true });
  const archive = execFileSync('git', ['archive', '2a8275d'], { cwd: candidate, maxBuffer: 64 * 1024 * 1024 });
  const unpack = spawnSync('tar', ['-x', '-C', baseline], { input: archive }); assert.equal(unpack.status, 0, unpack.stderr?.toString());
  await symlink(join(candidate, 'node_modules'), join(baseline, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error; });
  const rounds = [];
  // Alternate order to reduce warm-cache and temperature bias; each probe runs in a fresh process.
  for (const modes of [['baseline', 'idle', 'loaded'], ['loaded', 'idle', 'baseline']]) for (const mode of modes) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', mode === 'baseline' ? baseline : candidate, mode], { cwd: candidate, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.status, 0, `${mode}: ${child.stderr}\n${child.stdout}`);
    rounds.push(JSON.parse(child.stdout.trim().split('\n').at(-1)));
  }
  const merged = Object.fromEntries(['baseline', 'idle', 'loaded'].map(mode => [mode, rounds.filter(row => row.mode === mode)]));
  const worst = (mode, key, percentile) => Math.max(...merged[mode].map(row => key === 'health' || key === 'startup' ? row[key][percentile] : row.timings[key][percentile]));
  const checks = [];
  for (const mode of ['idle', 'loaded']) for (const key of ['startup', 'health', 'pcmDurableAck', 'transcriptPersisted', 'minutesAndHighlightsPersisted', 'chain', 'hostOverhead']) {
    const baselineMs = worst('baseline', key, 'p95Ms'), candidateMs = worst(mode, key, 'p95Ms');
    const slack = key === 'startup' ? 15 : key === 'health' ? 5 : 5;
    const maximum = key === 'startup' ? 2000 : key === 'health' ? 200 : 1000;
    checks.push({ mode, metric: key, baselineP95Ms: baselineMs, candidateP95Ms: candidateMs, allowedP95Ms: Math.min(maximum, baselineMs * 1.25 + slack), pass: candidateMs <= Math.min(maximum, baselineMs * 1.25 + slack) });
  }
  checks.push({ mode: 'idle-retention', metric: 'full-record-body-reads', allowedReads: 0, candidateReads: Math.max(...rounds.filter(row => row.mode !== 'baseline').map(row => row.idleRetentionReads)), pass: rounds.filter(row => row.mode !== 'baseline').every(row => row.idleRetentionReads === 0) });
  const output = { schema: 'pi-chain-benchmark/v1', baseline: '2a8275d', at: new Date().toISOString(), node: process.version, rounds, checks, retention: { baseline: 'no Pi runtime', observedCandidateReads: rounds.filter(row => row.mode !== 'baseline').map(row => ({ mode: row.mode, reads: row.idleRetentionReads, ms: row.retentionObservationMs })), note: 'counts full repo.get calls during idle polling; nonzero is an explicit retained-body scan concern, independent of timing gates' }, realProviders: false, realMeetingData: false, thresholds: 'p95 <= min(absolute cap, baseline p95*1.25+5ms slack (startup +15ms)); 2 independent rounds, each 2 warmups+12 measured chains by default' };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(output, null, 2) + '\n'); console.log(JSON.stringify(output, null, 2));
  assert.ok(checks.every(row => row.pass), 'Performance tolerance exceeded; inspect saved result.json');
}

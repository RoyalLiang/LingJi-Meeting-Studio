// Real native ASR over synthetic PCM, isolated local HTTP/storage; never reads provider credentials.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

assert.equal(process.version, 'v26.12.1');
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = join(project, '.agent-runtime/tasks/20261031-pi-chain-regression');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const stats = values => ({ count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), minMs: Math.min(...values), maxMs: Math.max(...values) });
if (process.argv[2] === '--probe') {
  const tree = resolve(process.argv[3]), mode = process.argv[4], audioDir = option('--audio-dir'), asrDir = option('--asr-dir');
  for (const key of Object.keys(process.env)) if (/^(RECORD_|LLM_|ASR_|DOUBAO_|FUNASR_|OPENAI_|ANTHROPIC_|LINGJI_)/.test(key)) delete process.env[key];
  process.env.RECORD_LEARNING_ENABLED = 'false'; process.env.RECORD_DEV_ACCOUNT = 'off';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...args) => { assert.equal(new URL(url).hostname, '127.0.0.1', 'benchmark forbids external requests'); return realFetch(url, ...args); };
  const load = path => import(pathToFileURL(join(tree, path)).href);
  const { createRecordServer } = await load('services/records/src/server.mjs');
  const { runCycle } = await load('services/records/src/worker.mjs');
  const { closeLocalAsr } = await load('services/records/src/local-asr.mjs');
  const { digest } = await load('packages/records/src/record.mjs');
  const expected = JSON.parse(await readFile(join(evidence, 'real-chain-result.json'), 'utf8')).transcript;
  const pcm = await Promise.all([0, 1, 2].map(i => readFile(join(audioDir, `speech-${i}.pcm`))));
  const root = await mkdtemp(join(tmpdir(), 'pi-native-asr-bench-')); let app;
  try {
    await writeFile(join(root, 'providers.json'), JSON.stringify({ ASR_PROVIDER: 'sensevoice-local', LINGJI_LOCAL_ASR_DIR: asrDir, MINUTES_MODE: 'asr-llm', RECORD_LEARNING_ENABLED: 'false' }), { mode: 0o600 });
    app = await createRecordServer({ root, port: 0, host: '127.0.0.1', seedDevelopment: false });
    const address = await app.start(), base = `http://127.0.0.1:${address.port}/api`; let headers = {};
    const registered = await fetch(base + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asr-benchmark@example.test', password: 'Synthetic-only-password-2026' }) });
    assert.equal(registered.status, 200); const user = await registered.json(); headers = { Cookie: registered.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf };
    const request = async (path, method = 'GET', body) => { const response = await fetch(base + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data; };
    const rows = [];
    for (let sample = 0; sample < 5; sample++) {
      let record = await request('/records', 'POST', { title: 'Native ASR benchmark: synthetic speech', language: 'zh', autoMinutes: false, retainAudio: true });
      const source = await request(`/records/${record.id}/sources`, 'POST', { kind: 'microphone', label: 'Synthetic speech PCM, no real microphone' });
      const uploads = []; let offset = 0; const chainAt = performance.now();
      for (let sequence = 0; sequence < pcm.length; sequence++) {
        const bytes = pcm[sequence], identity = { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence, sampleOffset: offset, sampleCount: bytes.length / 2, sampleRate: 16000, digest: digest(bytes) };
        const at = performance.now(), response = await fetch(base + `/records/${record.id}/audio`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Record-Audio': JSON.stringify(identity) }, body: bytes });
        const receipt = await response.json(); assert.equal(response.status, 200, JSON.stringify(receipt)); assert.equal(receipt.durable, true); assert.equal(receipt.watermark, sequence); uploads.push(performance.now() - at); offset += bytes.length / 2;
      }
      record = await request(`/records/${record.id}/seal`, 'POST', { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: pcm.length - 1 }] }); assert.equal(record.capture, 'sealed');
      const at = performance.now();
      for (let attempt = 0; attempt < 12; attempt++) {
        await runCycle(app.repo, {}, { lane: 'audio' }); record = await request(`/records/${record.id}`);
        if (record.capture === 'completed' && record.transcription === 'ready') break;
        assert.notEqual(record.transcription, 'failed', 'native ASR failed');
      }
      const asrMs = performance.now() - at;
      assert.equal(record.capture, 'completed'); assert.equal(record.transcription, 'ready');
      const transcript = record.segments.map(s => s.text).join('\n'); assert.equal(transcript, expected);
      const saved = await app.repo.get(record.id); assert.equal(saved.segments.map(s => s.text).join('\n'), expected); assert.equal(saved.jobs.length, 0, 'autoMinutes must remain disabled');
      rows.push({ sample, phase: sample === 0 ? 'cold-warmup' : 'warm', asrMs, uploadMs: uploads, chainMs: performance.now() - chainAt, transcriptEqual: true, persisted: true, segmentCount: record.segments.length });
    }
    console.log(JSON.stringify({ mode, node: process.version, audioSha256: pcm.map(digest), audioSeconds: pcm.reduce((n, b) => n + b.length / 2 / 16000, 0), asrDir, rows, nativeAsr: true, cloudCalls: false, minutesDisabled: true, data: 'OS synthesized speech only' }));
  } finally { await closeLocalAsr(); await app?.stop(); await rm(root, { recursive: true, force: true }); }
} else {
  const audioDir = resolve(option('--audio-dir') || JSON.parse(await readFile(join(evidence, 'real-chain-server.json'), 'utf8')).root);
  const asrDir = resolve(option('--asr-dir') || join(project, 'apps/desktop/src-tauri/resources/client-backend/local-asr'));
  const baseline = join(evidence, 'benchmark/baseline-2a8275d'), runs = [];
  const outputDir = join(evidence, 'local-asr-benchmark'); await mkdir(outputDir, { recursive: true });
  // Gates fixed before measurement: warm median +25%+100ms, warm p95 +25%+150ms, cold +50%+500ms, upload +25%+10ms.
  for (const order of [['baseline', 'candidate'], ['candidate', 'baseline']]) for (const mode of order) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', mode === 'baseline' ? baseline : project, mode, '--audio-dir', audioDir, '--asr-dir', asrDir], { cwd: project, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.status, 0, `${mode}: ${child.stderr}\n${child.stdout}`); runs.push(JSON.parse(child.stdout.trim().split('\n').at(-1)));
  }
  assert.ok(runs.every(run => JSON.stringify(run.audioSha256) === JSON.stringify(runs[0].audioSha256)));
  const summarize = mode => { const rows = runs.filter(run => run.mode === mode).flatMap(run => run.rows), warm = rows.filter(row => row.phase === 'warm'); return { coldAsr: stats(rows.filter(row => row.phase !== 'warm').map(row => row.asrMs)), warmAsr: stats(warm.map(row => row.asrMs)), warmChain: stats(warm.map(row => row.chainMs)), warmUploads: stats(warm.flatMap(row => row.uploadMs)) }; };
  const baselineResult = summarize('baseline'), candidateResult = summarize('candidate');
  const gates = [['warmAsr', 'p50Ms', 1.25, 100], ['warmAsr', 'p95Ms', 1.25, 150], ['coldAsr', 'p95Ms', 1.5, 500], ['warmUploads', 'p95Ms', 1.25, 10]].map(([metric, percentile, ratio, slackMs]) => ({ metric, percentile, baselineMs: baselineResult[metric][percentile], candidateMs: candidateResult[metric][percentile], maximumMs: baselineResult[metric][percentile] * ratio + slackMs, pass: candidateResult[metric][percentile] <= baselineResult[metric][percentile] * ratio + slackMs }));
  const output = { schema: 'pi-real-native-asr-benchmark/v1', at: new Date().toISOString(), baseline: '2a8275d', node: process.version, audioDir, asrDir, runs, baselineResult, candidateResult, gates, realProviders: 'local SenseVoice only; cloud disabled', warmup: 'first real transcription per process reported as cold, excluded from warm stats', comparability: 'same native model and PCM; AB/BA fresh processes, 1 cold+4 warm each, all 20 transcripts equal previous real-chain fixture' };
  await writeFile(join(outputDir, 'result.json'), JSON.stringify(output, null, 2) + '\n'); console.log(JSON.stringify(output, null, 2)); assert.ok(gates.every(gate => gate.pass), 'real local ASR performance gate failed');
}

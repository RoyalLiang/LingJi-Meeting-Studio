// Isolated transport timing: no .env, existing meetings, workers, or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRecordServer } from '../services/records/src/server.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { emit } from '../packages/records/src/record.mjs';

delete process.env.RECORD_DATABASE_URL;
delete process.env.RECORD_S3_BUCKET;
const root = await mkdtemp(join(tmpdir(), 'record-transport-'));
const repo = await createRepository({ root, databaseUrl: '' });
const app = await createRecordServer({ repo, port: 0 });
const abort = new AbortController();
try {
  const address = await app.start(), base = `http://127.0.0.1:${address.port}`;
  const registered = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'transport@example.test', password: 'isolated-transport-password' }) });
  const user = await registered.json();
  const headers = { Cookie: registered.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf, 'Content-Type': 'application/json' };
  const created = await fetch(`${base}/api/records`, { method: 'POST', headers, body: '{}' });
  const record = await created.json();
  const stream = await fetch(`${base}/api/records/${record.id}/events?after=${record.cursor}`, { headers, signal: abort.signal });
  const reader = stream.body.getReader();
  let buffered = '';
  async function until(pattern) {
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      while (!pattern.test(buffered)) {
        const { done, value } = await reader.read();
        assert.equal(done, false, 'SSE ended before the expected event');
        buffered += new TextDecoder().decode(value);
      }
      buffered = '';
    } finally { clearTimeout(timeout); }
  }
  const samples = [];
  for (let sequence = 0; sequence < 5; sequence++) {
    // Commit just after a heartbeat to expose the actual polling wait.
    await until(/: heartbeat/);
    const started = performance.now();
    await repo.change(record.id, r => { r.notes = `Synthetic ${sequence}`; emit(r, 'transcript.updated'); });
    await until(/"type":"transcript.updated"/);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const pcm = Buffer.alloc(32000);
  const metadata = { sourceId: record.id, epoch: record.id, sessionId: record.id, sequence: 0, sampleOffset: 0, sampleCount: 16000, sampleRate: 16000, digest: 'a'.repeat(64) };
  const jsonBytes = Buffer.byteLength(JSON.stringify({ ...metadata, pcm: pcm.toString('base64') }));
  const binaryBytes = pcm.length + Buffer.byteLength(JSON.stringify(metadata));
  const output = { audioPayload: { jsonBytes, binaryBytes, savedPercent: 100 * (1 - binaryBytes / jsonBytes) }, timestamp: new Date().toISOString(), scenario: 'isolated SQLite commit-to-SSE, immediately after heartbeat', samples: samples.length,
    p50Ms: samples[2], maxMs: samples.at(-1), realAudioDevices: false, realProviders: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output));
  if (process.argv.includes('--check')) assert.ok(output.maxMs < 200, `Commit-to-SSE exceeded 200ms: ${output.maxMs.toFixed(1)}ms`);
} finally {
  abort.abort(); await app.stop(); await rm(root, { recursive: true, force: true });
}

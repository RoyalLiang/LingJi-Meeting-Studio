import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { createRecordServer } from '../services/records/src/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'tts-native-fixture-'));
const output = join(root, 'probe.json');
// Isolated fixture: no worker or provider is started.
process.env.RECORD_PROVIDER = 'fixture'; process.env.NODE_ENV = 'test';
const apiOptions = { root: join(root, 'records'), port: 0, host: '127.0.0.1', databaseUrl: '', seedDevelopment: false };
const api = await createRecordServer(apiOptions);
let child, logs = '';
try {
  const address = await api.start();
  apiOptions.origin = `http://127.0.0.1:${address.port}`;
  const launch = () => spawn(resolve(process.env.NATIVE_CLIENT_EXECUTABLE || 'apps/desktop/src-tauri/target/debug/tts-client'), [], { env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    TTS_CLIENT_DATA_DIR: join(root, 'client'), TTS_RECORD_API_URL: `http://127.0.0.1:${address.port}`,
    TTS_CLIENT_SYNTHETIC: '1', TTS_CLIENT_PROBE_OUTPUT: output,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const waitProbe = async () => {
    for (let n = 0; n < 450; n++) {
      try { return JSON.parse(await readFile(output, 'utf8')); } catch { /* Wait for the isolated renderer. */ }
      if (child.exitCode != null) throw new Error(`Native client exited ${child.exitCode}: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Native probe timed out: ${logs}`);
  };
  child = launch();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-6000); });
  let result = await waitProbe();
  assert.ok(result, `Native probe timed out: ${logs}`); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.iframeBlocked, true); assert.ok(result.pcm.length >= 2);
  let offset = 0;
  result.pcm.forEach((packet, sequence) => { assert.equal(packet.sequence, sequence); assert.equal(packet.offset, offset); offset += packet.samples; });
  assert.equal(result.pcm[0].nonzero, true);
  const stored = await api.repo.get(result.recordId);
  assert.equal(stored.chunks.length, result.pcm.length); assert.equal(stored.sources[0].watermark, result.pcm.length - 1);
  assert.equal(stored.capture, 'paused');
  delete result.recordId;
  const initialOrigin = result.origin;
  child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); await rm(output);
  child = launch();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-6000); });
  const restarted = await waitProbe(); assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(restarted.origin, initialOrigin); assert.equal(restarted.indexedDbRetained, true); assert.equal(restarted.reloginRequired, true);
  assert.equal(restarted.priorUiQueueReplayed, true);
  const replayed = await api.repo.get(result.uiRecordId);
  assert.equal(replayed.sources[0].watermark, replayed.sources[0].lastSequence);
  assert.ok(replayed.chunks.length >= 2);
  const replayedUiReceipts = replayed.chunks.length; delete result.uiRecordId;
  result = { ...result, stableOriginAfterRestart: true, indexedDbRetainedAfterRestart: true, reloginRequiredAfterRestart: true };
  const evidence = { realQueueReplayedAfterRestart: true, replayedUiReceipts, timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    ...result, durableReceipts: stored.chunks.length, stoppedCapture: stored.capture, realAudioDevicesOpened: false, realProvidersInvoked: false };
  if (process.argv[2]) {
    const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ok: true, nativePcmPackets: result.pcm.length, totalSamples: offset, authenticated: result.authenticated, sse: result.sse, iframeBlocked: result.iframeBlocked }));
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  }
  await api.stop(); await rm(root, { recursive: true, force: true });
}

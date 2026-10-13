// Exercise the production bundle without enabling fixture IPC or opening audio devices.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'tts-native-package-'));
const output = join(root, 'probe-must-not-exist.json');
let bootstrap = false, child, logs = '';
const server = createServer((request, response) => {
  if (request.url === '/api/bootstrap') bootstrap = true;
  response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"unauthorized"}');
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const binary = resolve(process.env.NATIVE_CLIENT_EXECUTABLE || 'apps/desktop/src-tauri/target/release/bundle/macos/聆记.app/Contents/MacOS/tts-client');
  const bytes = await readFile(binary);
  assert.equal(bytes.includes(Buffer.from('合成音源 · 不采集真实设备')), false);
  assert.equal(bytes.includes(Buffer.from('native-fixture@local.test')), false);
  for (const marker of ['TTS_UPDATE_TEST_URL', 'TTS_UPDATE_TEST_EXECUTABLE', 'sandboxInstall']) assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
  child = spawn(binary, [], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    TTS_CLIENT_DATA_DIR: join(root, 'client'), TTS_RECORD_API_URL: `http://127.0.0.1:${server.address().port}`,
    TTS_CLIENT_SYNTHETIC: '1', TTS_CLIENT_PROBE_OUTPUT: output, TTS_UPDATE_TEST_URL: 'http://127.0.0.1:1/manifest', TTS_UPDATE_TEST_EXECUTABLE: '/must-not-be-used' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-6000); });
  for (let n = 0; n < 300 && !bootstrap; n++) {
    if (child.exitCode != null) throw new Error(`Packaged client exited ${child.exitCode}: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(bootstrap, true, `Packaged React did not request bootstrap: ${logs}`);
  await new Promise(resolve => setTimeout(resolve, 500));
  await assert.rejects(stat(output), { code: 'ENOENT' });
  const evidence = { timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    productionBundleStarted: true, embeddedReactRequestedBootstrap: true, fixtureCodeAbsent: true,
    fixtureEnvironmentIgnored: true, binaryBytes: bytes.length, realAudioDevicesOpened: false, realProvidersInvoked: false };
  if (process.argv[2]) {
    const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log(JSON.stringify(evidence));
} finally {
  if (child && child.exitCode == null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}

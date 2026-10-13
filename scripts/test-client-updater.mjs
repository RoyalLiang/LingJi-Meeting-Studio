import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createRecordServer } from '../services/records/src/server.mjs';

assert.equal(process.platform, 'darwin', 'The sandbox installer test currently targets macOS only');
const root = await mkdtemp(join(tmpdir(), 'tts-updater-fixture-'));
const cli = join(dirname(createRequire(import.meta.url).resolve('@tauri-apps/cli')), 'tauri.js');
const native = resolve(process.env.NATIVE_CLIENT_EXECUTABLE || 'apps/desktop/src-tauri/target/debug/tts-client');
const before = createHash('sha256').update(await readFile(native)).digest('hex');
let child, server, api;
function command(binary, args) { const result = spawnSync(binary, args, { stdio: 'pipe' }); assert.equal(result.status, 0, `${binary} failed (${result.status})`); }
try {
  const key = join(root, 'signing.key'); command(process.execPath, [cli, 'signer', 'generate', '--ci', '--password', '', '--write-keys', key]); await chmod(key, 0o600);
  const archiveRoot = join(root, 'archive'); const app = join(archiveRoot, 'Fixture.app');
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents', 'MacOS', 'tts-client'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(app, 'Contents', 'version'), '9.9.9');
  const artifact = join(root, 'fixture.app.tar.gz'); command('/usr/bin/tar', ['--disable-copyfile', '-czf', artifact, '-C', archiveRoot, 'Fixture.app']);
  command(process.execPath, [cli, 'signer', 'sign', '--private-key-path', key, '--password', '', '--app-version', '9.9.9', artifact]);
  const signature = (await readFile(`${artifact}.sig`, 'utf8')).trim(), pubkey = (await readFile(`${key}.pub`, 'utf8')).trim(), bytes = await readFile(artifact);
  server = createServer((request, response) => {
    if (request.url.startsWith('/artifact/')) { response.writeHead(200); response.end(request.url.endsWith('/bad-signature') ? Buffer.concat([bytes, Buffer.from('tampered')]) : bytes); return; }
    const testCase = request.url.split('/').at(-1);
    if (testCase === 'none') { response.writeHead(204); response.end(); return; }
    if (testCase === 'invalid') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>not metadata</html>'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: testCase === 'wrong-version' ? '9.9.10' : '9.9.9', url: `http://127.0.0.1:${server.address().port}/artifact/${testCase}`, signature }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.RECORD_PROVIDER = 'fixture'; process.env.NODE_ENV = 'test';
  api = await createRecordServer({ root: join(root, 'api'), port: 0, host: '127.0.0.1', databaseUrl: '', seedDevelopment: false }); const address = await api.start();
  const results = [];
  for (const testCase of ['invalid', 'none', 'bad-signature', 'wrong-version', 'valid']) {
    const directory = join(root, testCase), executable = join(directory, 'Fixture.app', 'Contents', 'MacOS', 'tts-client'), output = join(directory, 'probe.json');
    await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(directory, 'Fixture.app', 'Contents', 'version'), 'old');
    let logs = '';
    child = spawn(native, [], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TTS_CLIENT_DATA_DIR: directory, TTS_RECORD_API_URL: `http://127.0.0.1:${address.port}`, TTS_CLIENT_SYNTHETIC: '1', TTS_CLIENT_PROBE_OUTPUT: output,
      TTS_UPDATE_TEST_CASE: testCase, TTS_UPDATE_TEST_URL: `http://127.0.0.1:${server.address().port}/manifest/${testCase}`, TTS_UPDATE_TEST_PUBLIC_KEY: pubkey,
      TTS_UPDATE_TEST_EXECUTABLE: executable }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-6000); });
    let result;
    for (let n = 0; n < 450; n++) {
      try { result = JSON.parse(await readFile(output, 'utf8')); break; } catch { /* Isolated native fixture is still running. */ }
      assert.equal(child.exitCode, null, `Native updater exited: ${logs}`); await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(result, `Updater probe timed out: ${logs}`); assert.equal(result.ok, true, JSON.stringify(result));
    if (testCase === 'valid') { assert.equal(result.blockedInstalls, 8); assert.equal(await readFile(join(directory, 'Fixture.app', 'Contents', 'version'), 'utf8'), '9.9.9'); }
    else assert.equal(await readFile(join(directory, 'Fixture.app', 'Contents', 'version'), 'utf8'), 'old');
    results.push(result); child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); child = null;
  }
  assert.equal(createHash('sha256').update(await readFile(native)).digest('hex'), before, 'Development binary must stay unchanged');
  const evidence = { timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch, results,
    productionApplicationModified: false, realAudioDevicesOpened: false, realProvidersInvoked: false, realApplicationRestartTested: false };
  if (process.argv[2]) { const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n'); }
  console.log(JSON.stringify(evidence));
} finally {
  if (child && child.exitCode == null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  if (api) await api.stop(); if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}

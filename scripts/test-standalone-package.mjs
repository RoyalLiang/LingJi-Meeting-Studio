// Isolated lifecycle check. Never opens capture devices or invokes model providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createAuth } from '../services/records/src/auth.mjs';
import { digest } from '../packages/records/src/record.mjs';

const root = await mkdtemp(join(tmpdir(), 'lingji-standalone-'));
const data = join(root, 'client');
const profileKey = 'local://embedded-v1';
let proxyPort;
let child, logs = '', externalRequests = 0;
const trap = createServer((_request, response) => { externalRequests++; response.writeHead(503); response.end(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, allowExited = false) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; if (!allowExited && (child?.exitCode != null || child?.signalCode != null)) throw new Error(`Client exited while waiting for ${label}: ${logs}`); await delay(100); }
  throw new Error(`Timeout: ${label}: ${logs}`);
}
async function prepareNativeProfile() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  try {
    proxyPort = reservation.address().port;
    await mkdir(data, { recursive: true, mode: 0o700 });
    // Only this temporary test registry differs from the production default origin.
    await writeFile(join(data, 'profiles.json'), JSON.stringify({ [profileKey]: proxyPort }), { mode: 0o600 });
  } finally { await new Promise(resolve => reservation.close(resolve)); }
}
async function launch() {
  await rm(join(data, 'backend/runtime-state.json'), { force: true });
  const args = process.env.NATIVE_CLIENT_EXECUTABLE ? [] : [resolve(process.env.CLIENT_BACKEND_ENTRY || 'services/records/src/desktop-backend.mjs'), join(data, 'backend')];
  const requestedExecutable = process.env.NATIVE_CLIENT_EXECUTABLE || process.env.CLIENT_NODE_EXECUTABLE;
  const executable = requestedExecutable ? await realpath(requestedExecutable) : null;
  assert.ok(executable, 'Set NATIVE_CLIENT_EXECUTABLE or CLIENT_NODE_EXECUTABLE');
  logs = '';
  child = spawn(executable, args, { env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      ...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA,APPDATA:process.env.APPDATA,TEMP:process.env.TEMP,TMP:process.env.TMP}:{}),
    TTS_CLIENT_DATA_DIR: data, TTS_RECORD_API_URL: `http://127.0.0.1:${trap.address().port}`,
    TTS_CLIENT_SYNTHETIC: '1', TTS_CLIENT_PROBE_OUTPUT: join(root, 'must-not-exist.json'),
    TTS_UPDATE_TEST_URL: 'http://127.0.0.1:1/manifest', TTS_UPDATE_TEST_EXECUTABLE: '/must-not-be-used',
    RECORD_DATABASE_URL: 'postgres://must-not-be-used.invalid/tts', RECORD_S3_BUCKET: 'must-not-be-used',
    RECORD_DEV_ACCOUNT: 'on', RECORD_CONFIG_ADMIN: 'developer@invalid.test',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  // The private handshake contains a session cookie. Do not retain or print stdout.
  child.stdout.resume(); child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-3000); });
  const state = await until(async () => { try { return JSON.parse(await readFile(join(data, 'backend/runtime-state.json'), 'utf8')); } catch { return null; } }, 'backend handshake');
  if (process.env.NATIVE_CLIENT_EXECUTABLE) await until(async () => {
    try {
      const profiles = JSON.parse(await readFile(join(data, 'profiles.json'), 'utf8'));
      if (profiles[profileKey] !== proxyPort || !(await stat(join(data, 'profiles', digest(profileKey)))).isDirectory()) return false;
      // Production HTML requires the WebView's private session. This checks only page proxy readiness.
      const response = await fetch(`http://127.0.0.1:${proxyPort}/`, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
      return response.status === 403 && (await response.json()).error === 'client_session_required';
    } catch { return false; }
  }, 'native profile registration and page proxy readiness');
  assert.equal(state.node, 'v24.21.0'); assert.equal(state.sqlite, '3.53.4');
  assert.equal(new URL(state.url).hostname, '127.0.0.1'); assert.notEqual(new URL(state.url).port, String(trap.address().port));
  const auth = await createAuth({ root: join(data, 'backend') });
  const user = { id: `user:${digest('local@device.invalid')}`, authVersion: 1 };
  const headers = { Cookie: auth.issue(user).split(';')[0], 'X-CSRF-Token': auth.csrf(user), 'Content-Type': 'application/json' };
  const result = await fetch(state.url + '/api/bootstrap', { headers });
  assert.equal(result.status, 200);
  const boot = await result.json(); assert.equal(boot.localAccount, true); assert.equal(boot.email, 'local@device.invalid');
  if(process.env.TTS_VERIFY_BUNDLED_ASR==='1') {
    assert.equal(boot.providers.asrProvider,'sensevoice-local');
    assert.equal(boot.providers.asr,true);
    const settings=await fetch(state.url+'/api/settings/providers',{headers});
    assert.equal(settings.status,200);
    const {values}=await settings.json();
    assert.equal(values.LOCAL_ASR_AVAILABLE,true);assert.equal(values.ASR_PROVIDER,'sensevoice-local');
    assert.equal('LINGJI_LOCAL_ASR_DIR' in values,false);
  }
  if(process.env.TTS_VERIFY_BUNDLED_ASR==='0') {
    const settings=await fetch(state.url+'/api/settings/providers',{headers});
    assert.equal(settings.status,200);
    const {values}=await settings.json();
    assert.equal(values.LOCAL_ASR_AVAILABLE,false);
    assert.notEqual(values.ASR_PROVIDER,'sensevoice-local');
    assert.equal(boot.providers.asr,false,'a fresh cloud-only install requires user credentials');
  }
  assert.equal((await fetch(state.url + '/api/development-account')).status, 404);
  assert.equal((await fetch(state.url + '/api/auth/register', { method: 'POST' })).status, 404);
  state.headers = headers;
  if(process.platform!=='win32') assert.equal((await stat(join(data, 'backend'))).mode & 0o777, 0o700);
  return state;
}
async function stop(state) {
  if (!child || child.exitCode != null) return;
  const stopped = new Promise(resolve => child.once('exit', resolve));
  if (process.env.NATIVE_CLIENT_EXECUTABLE) child.kill('SIGTERM'); else child.stdin.end();
  await Promise.race([stopped, delay(8000).then(() => { if (child.exitCode == null) { child.kill('SIGKILL'); throw new Error('Client failed to exit'); } })]);
  await until(async () => { try { await fetch(state.url + '/api/bootstrap'); return false; } catch { return true; } }, 'owned backend shutdown', true);
}
try {
  if (process.env.NATIVE_CLIENT_EXECUTABLE) {
    const binary = await readFile(process.env.NATIVE_CLIENT_EXECUTABLE);
    for (const marker of ['合成音源 · 验证', 'native-fixture@local.test', 'TTS_UPDATE_TEST_URL', 'TTS_UPDATE_TEST_EXECUTABLE', 'TTS_UPDATE_TEST_OUTPUT']) assert.equal(binary.includes(Buffer.from(marker)), false, `Fixture code leaked: ${marker}`);
  }
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  if (process.env.NATIVE_CLIENT_EXECUTABLE) await prepareNativeProfile();
  let state = await launch();
  const headers = state.headers;
  const created = await fetch(state.url + '/api/records', { method: 'POST', headers, body: '{}' });
  assert.equal(created.status, 201); const record = await created.json();
  const profile = process.env.NATIVE_CLIENT_EXECUTABLE ? await readFile(join(data, 'profiles.json'), 'utf8') : null;
  await stop(state); state = await launch();
  const restored = await fetch(state.url + '/api/records/' + record.id, { headers: state.headers });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).id, record.id);
  if (profile) assert.equal(await readFile(join(data, 'profiles.json'), 'utf8'), profile);
  assert.equal(externalRequests, 0); await assert.rejects(stat(join(root, 'must-not-exist.json')), { code: 'ENOENT' });
  await stop(state);
  const evidence = { timestamp: new Date().toISOString(), packagedApp: Boolean(process.env.NATIVE_CLIENT_EXECUTABLE), independentBackend: true, bundledAsrConfigured: process.env.TTS_VERIFY_BUNDLED_ASR==='1', developerBackendRequests: externalRequests, restartPersistence: true, stableWebviewProfile: Boolean(profile), parentOwnsBackend: true, localAccount: true, devAccountDisabled: true, node: state.node, sqlite: state.sqlite, realAudioDevicesOpened: false, realProvidersInvoked: false };
  if (process.argv[2]) { const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n'); }
  console.log(JSON.stringify(evidence));
} catch (error) {
  const backendLog = await readFile(join(data, 'backend/runtime.log'), 'utf8').catch(() => '(runtime log unavailable)');
  console.error('[isolated packaged backend]', backendLog.slice(-6000));
  throw error;
} finally {
  if (child && child.exitCode == null) { child.kill('SIGKILL'); }
  await new Promise(resolve => trap.close(resolve));
  if (process.env.CLIENT_SMOKE_KEEP_DATA === '1') console.log(`Isolated test data: ${root}`); else await rm(root, { recursive: true, force: true, maxRetries:50, retryDelay:100 });
}

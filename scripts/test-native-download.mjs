import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecordServer } from '../services/records/src/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'tts-native-download-'));
const output = join(root, 'probe.json'), downloads = join(root, 'downloads'), client = join(root, 'client');
const api = await createRecordServer({ root: join(root, 'records'), databaseUrl: '', port: 0, seedDevelopment: false });
let child, logs = '';
try {
  await mkdir(downloads); await mkdir(client);
  const address = await api.start(), apiUrl = `http://127.0.0.1:${address.port}`;
  const call = async (path, body, headers = {}) => {
    const response = await fetch(apiUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal(response.ok, true, `${path}:${response.status}`); return { response, data: await response.json() };
  };
  const login = await call('/api/auth/register', { email: 'download-fixture@example.invalid', password: 'SyntheticDownload2026!' });
  const headers = { Cookie: login.response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': login.data.csrf };
  const created = await call('/api/records', { title: '分享下载合成验收' }, headers), id = created.data.id;
  await api.repo.change(id, record => {
    const snapshot = [
      { id: 'fixture-cited', revision: 1, sourceId: 'fixture', text: '周五发布合成版本。', startMs: 0, endMs: 2000, speaker: '说话人 1', edited: false },
      { id: 'fixture-private', revision: 1, sourceId: 'fixture', text: '未分享的合成私密原文。', startMs: 2000, endMs: 4000, speaker: '说话人 1', edited: false },
    ];
    record.capture = 'completed'; record.transcription = 'ready'; record.segments = snapshot; record.transcriptRevision = 2;
    record.minutes = { title: '发布合成版本', revision: 1, transcriptRevision: 2, edited: false, evidenceSnapshot: snapshot, sections: [{ heading: '发布', items: [{ text: '周五发布合成版本。', evidence: [{ segmentId: 'fixture-cited', revision: 1 }] }] }], actions: [], extra: '不得导出的内部字段' };
  });
  const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const proxyPort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  await writeFile(join(client, 'profiles.json'), JSON.stringify({ [apiUrl]: proxyPort }));
  child = spawn(resolve(process.env.NATIVE_CLIENT_EXECUTABLE || 'apps/desktop/src-tauri/target/debug/tts-client'), [], { env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    TTS_CLIENT_DATA_DIR: client, TTS_RECORD_API_URL: apiUrl, TTS_CLIENT_PROBE_OUTPUT: output,
    TTS_CLIENT_DOWNLOAD_TEST_DIR: downloads, TTS_CLIENT_DOWNLOAD_TEST_RECORD: id,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-4000); });
  let result;
  for (let index = 0; index < 450; index++) {
    try { result = JSON.parse(await readFile(output, 'utf8')); break; } catch { /* Wait only for this fixture's renderer. */ }
    if (child.exitCode !== null) throw new Error(`Native fixture exited ${child.exitCode}: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(result, `Native download fixture timed out: ${logs}`); assert.equal(result.ok, true, JSON.stringify(result));
  const files = await readdir(downloads); assert.equal(files.length, 1); assert.match(files[0], /\.html$/);
  const html = await readFile(join(downloads, files[0]), 'utf8');
  assert.match(html, /周五发布合成版本。/); assert.doesNotMatch(html, /未分享的合成私密原文|不得导出的内部字段|<script/);
  assert.match(html, /default-src 'none'/);
  const evidence = { ...result, timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch, downloadedFileVerified: true, minimumDisclosureVerified: true, privateTempDestination: true, bytes: Buffer.byteLength(html) };
  if (process.argv[2]) { const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2) + '\n'); }
  console.log(JSON.stringify(evidence));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  await api.stop(); await rm(root, { recursive: true, force: true });
}

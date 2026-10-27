import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalAsrClient, LOCAL_ASR_MODEL, verifyLocalAsrAssets } from '../services/records/src/local-asr.mjs';
import { normalizeConfig, publicConfig, saveConfig, readConfig } from '../services/records/src/config.mjs';
import { providerStatus } from '../services/records/src/providers.mjs';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-native-asr-'));
  const worker = join(root, 'ipc-test.mjs');
  await writeFile(worker, `import {createInterface} from 'node:readline';
process.stdout.write(JSON.stringify({protocol:1,ready:true,model:${JSON.stringify(LOCAL_ASR_MODEL)}})+'\\n');
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line),code=Buffer.from(request.pcm,'base64')[0];
 if(code===99)process.exit(7);
 if(code===98){await new Promise(()=>{});continue;}
 if(code===97){process.stdout.write(JSON.stringify({id:request.id,text:17})+'\\n');continue;}
 const b=Buffer.from(JSON.stringify({id:request.id,text:'会议结果：'+process.pid})+'\\n');
 const at=b.indexOf(Buffer.from('会'))+1;process.stdout.write(b.subarray(0,at));
 await new Promise(done=>setTimeout(done,10));process.stdout.write(b.subarray(at));
}
`);
  const client = new LocalAsrClient(root, { workerPath: worker, verify: async () => {}, timeoutMs: 1500, idleMs: 60 });
  try { await work(client, root); } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}
const request = code => Buffer.from([code, 0]);
const wait = ms => new Promise(done => setTimeout(done, ms));
test('native IPC preserves fragmented Chinese output, serializes requests and releases idle process', async () => fixture(async client => {
  const [a, b] = await Promise.all([client.transcribe(request(1)), client.transcribe(request(2))]);
  assert.match(a, /^会议结果：\d+$/); assert.equal(a, b);
  await wait(180);
  const c = await client.transcribe(request(1)); assert.notEqual(c, a);
}));
test('native crash and invalid response reject promptly; subsequent audio starts a new process', async () => fixture(async client => {
  await assert.rejects(client.transcribe(request(99)), { code: 'local_asr_unavailable' });
  assert.match(await client.transcribe(request(1)), /^会议结果：/);
  await assert.rejects(client.transcribe(request(97)), { code: 'local_asr_invalid_response' });
  assert.match(await client.transcribe(request(1)), /^会议结果：/);
}));
test('native timeout terminates stalled process and queued work recovers', { timeout: 10000 }, async () => fixture(async client => {
  const stalled = client.transcribe(request(98));
  const following = client.transcribe(request(1));
  await assert.rejects(stalled, { code: 'local_asr_timeout' });
  assert.match(await following, /^会议结果：/);
}));
test('native shutdown rejects in-flight work and forbids accidental restart', async () => fixture(async client => {
  const work = client.transcribe(request(98));
  const checked = assert.rejects(work, { code: 'local_asr_shutdown' });
  await wait(100); await client.close(); await checked;
  await assert.rejects(client.transcribe(request(1)), { code: 'local_asr_shutdown' });
}));

test('bundled resource validation detects missing/corrupt data and rejects paths outside model directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-asr-assets-'));
  try {
    const names = ['sensevoice/model.int8.onnx', 'sensevoice/tokens.txt', 'silero_vad.onnx', 'NOTICE.txt', 'licenses/a', 'licenses/b'];
    const files = [];
    for (const name of names) {
      const bytes = Buffer.from(name); await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), bytes);
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const prefix = `node_modules/sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}/`;
    const nativeFiles = ['sherpa-onnx.node', 'a.dylib', 'b.dylib', 'libsherpa.so', 'libonnxruntime.so.1'].map(name => prefix + name);
    for (const name of nativeFiles) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), 'native test resource'); }
    const manifest = { model: LOCAL_ASR_MODEL, runtime: '1.13.8', platform: process.platform, arch: process.arch, files, nativeFiles };
    const save = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await save(); await verifyLocalAsrAssets(root);
    await writeFile(join(root, names[0]), 'changed');
    await assert.rejects(verifyLocalAsrAssets(root), { code: 'local_asr_assets_invalid' });
    files[0].path = '../outside'; await save();
    await assert.rejects(verifyLocalAsrAssets(root), { code: 'local_asr_assets_invalid' });
    await rm(join(root, 'manifest.json'));
    await assert.rejects(verifyLocalAsrAssets(root), { code: 'local_asr_assets_missing' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundled default is local, cloud/custom providers stay explicit, model path is never public or user-editable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-asr-default-'));
  try {
    await writeFile(join(root, 'manifest.json'), '{}');
    const env = { NODE_ENV: 'desktop', LINGJI_LOCAL_ASR_DIR: root, LLM_API_KEY: '' };
    const config = normalizeConfig(env);
    assert.equal(config.ASR_PROVIDER, 'sensevoice-local'); assert.equal(providerStatus(config).asr, true);
    assert.equal(normalizeConfig({ ...env, ASR_PROVIDER: 'funasr', FUNASR_API_URL: 'https://example.com/v1/audio/transcriptions' }).ASR_PROVIDER, 'funasr');
    assert.equal(normalizeConfig({ ...env, DOUBAO_API_KEY: 'configured-key' }).ASR_PROVIDER, 'doubao');
    const published = publicConfig(config); assert.equal(published.LOCAL_ASR_AVAILABLE, true); assert.ok(!JSON.stringify(published).includes(root));
    await saveConfig(root, { ASR_PROVIDER: 'sensevoice-local', LINGJI_LOCAL_ASR_DIR: '/untrusted/path' }, env);
    assert.equal((await readConfig(root, env)).LINGJI_LOCAL_ASR_DIR, root);
    await assert.rejects(saveConfig(root, { ASR_PROVIDER: 'sensevoice-local' }, { NODE_ENV: 'test' }), { code: 'local_asr_assets_missing' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shutdown rejects a delayed registry entry before creating another child', async () => {
  const { closeLocalAsr, openLocalAsr, transcribeLocalAsr } = await import('../services/records/src/local-asr.mjs');
  await closeLocalAsr();
  await assert.rejects(transcribeLocalAsr(Buffer.alloc(32000), {}), { code: 'local_asr_shutdown' });
  openLocalAsr();
  await assert.rejects(transcribeLocalAsr(Buffer.alloc(32000), {}), { code: 'local_asr_assets_missing' });
});

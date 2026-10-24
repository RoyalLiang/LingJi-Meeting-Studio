import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const lock = JSON.parse(await readFile(new URL('../services/records/src/local-asr-resources.json', import.meta.url), 'utf8'));
async function digest(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest(encoding);
}
async function download(url, file, algorithm, expected, encoding = 'hex') {
  try { if (await digest(file, algorithm, encoding) === expected) return file; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
    assert.ok(response.ok && response.body, `Local ASR resource download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    assert.equal(await digest(temporary, algorithm, encoding), expected, `Local ASR resource digest mismatch: ${url}`);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return file;
}
async function filesAt(root, prefix = '') {
  const files = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await filesAt(root, path));
    else { assert.ok(item.isFile(), `Unexpected local ASR resource: ${path}`); files.push(path); }
  }
  return files.sort();
}
export async function prepareLocalAsr({ destination, cacheRoot, platform = process.platform, arch = process.arch }) {
  const target = `${platform}-${arch}`;
  assert.ok(lock.packages[target], `Bundled local ASR target not supported: ${target}`);
  const stage = `${destination}.preparing-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  try {
    for (const pkg of [lock.packages.common, lock.packages[target]]) {
      const [algorithm, expected] = pkg.integrity.split('-');
      const archive = await download(pkg.url, join(cacheRoot, `${pkg.name}-${pkg.version}.tgz`), algorithm, expected, 'base64');
      const extracted = join(stage, 'node_modules', pkg.name);
      const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
      assert.ok(paths.length < 1000 && paths.every(path => path.startsWith('package/') && !path.split('/').includes('..') && !path.includes('\\')));
      await mkdir(extracted, { recursive: true });
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted]);
      assert.equal(JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8')).version, pkg.version);
    }
    for (const resource of lock.files) {
      const cached = await download(resource.url, join(cacheRoot, resource.sha256), 'sha256', resource.sha256);
      assert.equal((await stat(cached)).size, resource.bytes);
      await mkdir(dirname(join(stage, resource.path)), { recursive: true });
      await cp(cached, join(stage, resource.path));
    }
    const notice = `聆记本地转录\n\nSenseVoiceSmall by FunAudioLLM / Alibaba DAMO Academy.\nONNX conversion and native inference by k2-fsa/sherpa-onnx.\nModel revision: ${lock.modelRevision}\nRuntime: sherpa-onnx ${lock.runtime}; ONNX Runtime ${lock.onnxruntime}.\nSilero VAD by Silero Team.\n\nModel weights and software have separate licenses. See licenses/ for the model agreement, Apache-2.0, MIT and third-party notices.\nOriginal model: https://huggingface.co/FunAudioLLM/SenseVoiceSmall\nConverted model: https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html\n`;
    await writeFile(join(stage, 'NOTICE.txt'), notice);
    const files = [], nativeFiles = [];
    for (const path of await filesAt(stage)) {
      const full = join(stage, path);
      if (/\.(node|dylib|dll)$/i.test(path)) { nativeFiles.push(path); continue; }
      files.push({ path, bytes: (await stat(full)).size, sha256: await digest(full) });
    }
    // macOS re-signs native libraries during bundling. Verify model/data/JS
    // hashes here; native payload provenance is pinned by npm SRI and the final
    // installer digest/signature, and each library's presence is checked at use.
    const manifest = { schema: 1, model: lock.model, runtime: lock.runtime, onnxruntime: lock.onnxruntime, platform, arch, modelRevision: lock.modelRevision, packages: [lock.packages.common, lock.packages[target]], files, nativeFiles };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
    return { model: lock.model, runtime: lock.runtime, onnxruntime: lock.onnxruntime, files: files.length, nativeFiles: nativeFiles.length, offline: true, pythonRequired: false };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await prepareLocalAsr({ destination: process.argv[2] || join(root, 'apps/desktop/src-tauri/resources/client-backend/local-asr'), cacheRoot: process.env.TTS_LOCAL_ASR_CACHE || join(root, '.agent-runtime/local-asr-cache') })));
}

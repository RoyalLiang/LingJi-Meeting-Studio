import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.21.0';
const runtimes = {
  'darwin-arm64': ['tar.xz', '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe'],
  'darwin-x64': ['tar.xz', '0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299'],
  'linux-x64': ['tar.xz', 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'],
  'win-x64': ['zip', '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'],
};
export async function prepareClientBackend({ root = project, cacheRoot = join(project, '.agent-runtime/runtimes') } = {}) {
  const target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  assert.ok(runtimes[target], `Bundled runtime is not configured for ${target}`);
  const [extension, expected] = runtimes[target];
  const archive = `node-v${version}-${target}.${extension}`;
  const cache = join(cacheRoot, `node-v${version}-${target}`), tar = join(cache, archive);
  await mkdir(cache, { recursive: true });
  try { await access(tar); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://nodejs.org/dist/v${version}/${archive}`, { signal: AbortSignal.timeout(180000) });
    assert.ok(response.ok, `Official Node download failed: ${response.status}`);
    await writeFile(tar, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
  }
  assert.equal(createHash('sha256').update(await readFile(tar)).digest('hex'), expected, 'Official runtime checksum mismatch.');
  const extracted = join(cache, `node-v${version}-${target}`);
  // Copy from the verified archive every time, including when a cache exists.
  await rm(extracted, { recursive: true, force: true });
  execFileSync('tar', ['-xf', tar, '-C', cache]);
  const binary = join(extracted, ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  const verified = JSON.parse(execFileSync(binary, ['--input-type=module', '-e', 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(":memory:");db.exec("CREATE VIRTUAL TABLE f USING fts5(content)");console.log(JSON.stringify({node:process.version,sqlite:db.prepare("SELECT sqlite_version() v").get().v,fts5:true,platform:process.platform,arch:process.arch}));db.close()'], { encoding: 'utf8' }));
  assert.equal(verified.node, `v${version}`); assert.equal(verified.sqlite, '3.53.4'); assert.equal(verified.arch, process.arch);
  assert.equal(verified.platform, process.platform);
  const resources = join(root, 'apps/desktop/src-tauri/resources');
  const runtime = join(resources, 'runtime'), backend = join(resources, 'client-backend');
  await mkdir(runtime, { recursive: true });
  await rm(backend, { recursive: true, force: true });
  await mkdir(backend, { recursive: true });
  const runtimeBinary = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(binary, runtimeBinary); await chmod(runtimeBinary, 0o755);
  await copyFile(join(extracted, 'LICENSE'), join(runtime, 'LICENSE'));
  for (const path of ['services/records/src', 'packages/records/src', 'services/session-gateway/src/providers/doubao-ast-codec.mjs', 'services/session-gateway/src/providers/doubao-ast/protos']) {
    await cp(join(root, path), join(backend, path), { recursive: true, filter: path => !path.endsWith('.DS_Store') });
  }
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const modules = new Map(), pending = ['ws', 'protobufjs'];
  while (pending.length) {
    const name = pending.shift();
    if (modules.has(name)) continue;
    let directory = join(root, 'node_modules', name);
    try { await access(join(directory, 'package.json')); }
    catch { directory = dirname(createRequire(join(root, 'package.json')).resolve(name)); }
    let pkg;
    for (;;) {
      try { const candidate = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (candidate.name === name) { pkg = candidate; break; } } catch { /* Walk to package root. */ }
      const parent = dirname(directory); assert.notEqual(parent, directory, `Dependency package not found: ${name}`); directory = parent;
    }
    assert.equal(pkg.version, lock.packages[`node_modules/${name}`]?.version, `Installed dependency differs from lockfile: ${name}`);
    modules.set(name, pkg.version);
    await cp(directory, join(backend, 'node_modules', name), { recursive: true, dereference: true, filter: path => !path.includes('/node_modules/node_modules/') && !path.endsWith('.DS_Store') });
    pending.push(...Object.keys(pkg.dependencies || {}));
  }
  // Verify the packaged import graph, rather than accidentally resolving from
  // the repository's node_modules or source-only provider files.
  const isolated = await mkdtemp(join(tmpdir(), 'lingji-backend-import-'));
  try {
    await cp(backend, isolated, { recursive: true, dereference: true });
    execFileSync(binary, ['--input-type=module', '-e', 'await import(process.argv[1]);', pathToFileURL(join(isolated, 'services/records/src/desktop-backend.mjs')).href]);
  } finally { await rm(isolated, { recursive: true, force: true }); }
  const metadata = { ...verified, archive, archiveSha256: expected, dependencies: Object.fromEntries(modules), backendBundled: true, externalDevelopmentServiceRequired: false };
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepareClientBackend({ cacheRoot: process.env.TTS_RUNTIME_CACHE || undefined })));

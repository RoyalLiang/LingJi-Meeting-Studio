import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeResourceHashes } from '../scripts/prepare-installer-theme.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-hash-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, resources: join(root, 'resources'), output: join(root, 'hashes.nsh') };
}
async function resource(root, name, content) {
  const file = join(root, ...name.split('\\'));
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
}

for (const unsafe of ['$name', 'quote"name', 'line\nname', 'brace{name}']) {
  test(`installer hash generator rejects unsafe destination ${JSON.stringify(unsafe)}`, async t => {
    const f = await fixture(t);
    const folder = join(f.resources, 'client-backend'); await mkdir(folder, { recursive: true });
    // Windows cannot create quotes/newlines; enumerate the hostile name to assert validation precedes file reads.
    const original = fs.readdir;
    const mocked = t.mock.method(fs, 'readdir', async (path, options) => path === folder
      ? [{ name: unsafe, isFile: () => true, isDirectory: () => false }] : original(path, options));
    syncBuiltinESMExports();
    try { await assert.rejects(writeResourceHashes(f.resources, f.output), /Unsafe installer resource path/); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  });
}

test('installer hash generator rejects destinations colliding under Windows case rules', async t => {
  const f = await fixture(t);
  await resource(f.resources, 'client-backend\\alpha.txt', 'first');
  await resource(f.resources, 'client-backend\\ALPHA.txt', 'second');
  // A folded host cannot store both names; expose the two real directory entries a Windows build must reject.
  const folder = join(f.resources, 'client-backend'), original = fs.readdir;
  const mocked = t.mock.method(fs, 'readdir', async (path, options) => {
    if (path !== folder) return original(path, options);
    return ['alpha.txt', 'ALPHA.txt'].map(name => ({ name, isFile: () => true, isDirectory: () => false }));
  });
  syncBuiltinESMExports();
  try { await assert.rejects(writeResourceHashes(f.resources, f.output), /collid|duplicate|Unsafe installer resource path/i); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

const compiler = process.env.NSIS_COMPILER || 'makensis';
const compilerProbe = spawnSync(compiler, ['-VERSION'], { encoding: 'utf8', timeout: 5000 });
const compilerAvailable = compilerProbe.status === 0;
test('actual resource hash generator compiles 4000 exact lookups with case, paths and missing values within 30 seconds', { timeout: 45000 }, async t => {
  if (!compilerAvailable) {
    assert.notEqual(process.env.NSIS_REQUIRE_COMPILER, '1', 'NSIS compiler required but unavailable; set NSIS_COMPILER and NSISDIR.');
    t.skip('NSIS compiler unavailable; set NSIS_COMPILER/NSISDIR or NSIS_REQUIRE_COMPILER=1 in compiler CI.'); return;
  }
  const f = await fixture(t), entries = [];
  const special = ['client-backend\\MixedCase\\asset.txt', 'client-backend\\space dir\\file name.txt', 'client-backend\\会议\\资料.txt', 'client-backend\\symbols #;[]()&=,!\\asset.txt', 'client-backend\\left\\same.txt', 'client-backend\\right\\same.txt', 'runtime\\node.exe'];
  for (let n = 0; n < 4000; n++) {
    const name = special[n] || `client-backend\\generated\\asset-${String(n).padStart(5, '0')}.txt`, content = `unique synthetic bytes ${n}`;
    await resource(f.resources, name, content); entries.push([name, digest(content)]);
  }
  assert.equal(await writeResourceHashes(f.resources, f.output), entries.length);
  const calls = entries.map(([name, hash]) => `!insertmacro AssertHash "${name}" "${hash}"`);
  calls.push(`!insertmacro AssertHash "CLIENT-BACKEND\\mixedcase\\ASSET.TXT" "${entries[0][1]}"`);
  calls.push('!insertmacro AssertHash "client-backend\\missing.txt" ""');
  calls.push(`!insertmacro AssertHash "${entries[1][0]}" "${entries[1][1]}"`);
  calls.push('!insertmacro AssertHash "runtime\\missing-after-hit.txt" ""');
  await writeFile(join(f.root, 'fixture.nsi'), [
    'Unicode true', 'Name "Production installer hash regression"', 'OutFile "fixture.exe"', 'SetCompress off', '!include "hashes.nsh"',
    '!macro AssertHash destination expected', '!insertmacro LingJiExpectedHash "${destination}"',
    '!if "${LINGJI_RESOURCE_SHA256}" S!= "${expected}"', '!error "Hash mismatch: ${destination}"', '!endif',
    // Match the production caller: it consumes the result then undefines it before the next lookup.
    '!undef LINGJI_RESOURCE_SHA256', '!macroend', ...calls, 'Section "Fixture"', 'DetailPrint "All production hash assertions passed"', 'SectionEnd', '',
  ].join('\n'));
  const compiled = spawnSync(compiler, ['-V2', 'fixture.nsi'], { cwd: f.root, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(compiled.error?.code, undefined, `NSIS compile failed: ${compiled.error?.code}\n${compiled.stdout}\n${compiled.stderr}`);
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executable = await readFile(join(f.root, 'fixture.exe'));
  assert.equal(executable.subarray(0, 2).toString(), 'MZ', 'Compiler must produce a Windows PE executable');
});

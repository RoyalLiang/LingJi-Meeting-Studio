import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('desktop backend starts through a directory alias and stops on parent EOF', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-entry-'));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const alias = join(root, 'installed app');
  let child;
  try {
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const data = join(root, 'data');
    child = spawn(process.execPath, [join(alias, 'services/records/src/desktop-backend.mjs'), data], {
      env: { ...process.env, RECORD_LEARNING_ENABLED: 'false' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000); });
    const stopped = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    const handshake = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('backend handshake timeout: ' + stderr)), 10000);
      child.stdout.on('data', bytes => {
        output += bytes;
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`backend exited before handshake (${code}): ${stderr}`)); });
    });
    assert.equal(handshake.protocol, 1);
    assert.equal(new URL(handshake.url).hostname, '127.0.0.1');
    assert.equal((await fetch(handshake.url + '/api/health')).status, 200);
    assert.equal(JSON.parse(await readFile(join(data, 'runtime-state.json'), 'utf8')).url, handshake.url);
    child.stdin.end();
    assert.equal(await stopped, 0);
    await assert.rejects(fetch(handshake.url + '/api/health'));
  } finally {
    if (child && child.exitCode == null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('installer resource hashes follow packaged bytes with safe deterministic destinations', async () => {
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {writeResourceHashes}=await import('../scripts/prepare-installer-theme.mjs');
  const root=await mkdtemp(join(tmpdir(),'lingji-resource-hashes-'));
  try {
    await mkdir(join(root,'resources/client-backend/local-asr'),{recursive:true});
    await writeFile(join(root,'resources/client-backend/local-asr/model.bin'),'abc');
    const output=join(root,'generated/hashes.nsh');
    assert.equal(await writeResourceHashes(join(root,'resources'),output),1);
    const original=await readFile(output,'utf8');
    assert.ok(original.includes('client-backend\\local-asr\\model.bin'));
    assert.ok(original.includes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
    await writeResourceHashes(join(root,'resources'),output);assert.equal(await readFile(output,'utf8'),original);
    await writeFile(join(root,'resources/client-backend/local-asr/model.bin'),'changed');
    await writeResourceHashes(join(root,'resources'),output);assert.notEqual(await readFile(output,'utf8'),original);
    await writeFile(join(root,'resources/client-backend/$unsafe'),'bad');
    await assert.rejects(writeResourceHashes(join(root,'resources'),output),/Unsafe installer resource path/);
  } finally {await rm(root,{recursive:true,force:true});}
});

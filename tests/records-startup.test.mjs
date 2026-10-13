import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function listen(host = '127.0.0.1', port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
async function freePort() { const server = await listen(); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(40); }
  throw new Error('Startup fixture did not become ready');
}
async function fixture(t, env = {}, args = []) {
  const root = await mkdtemp(join(tmpdir(), 'tts-startup-'));
  for (const dir of ['scripts', 'services/records/src', 'apps/web/src', 'bin']) await mkdir(join(root, dir), { recursive: true });
  await copyFile(new URL('../scripts/dev.mjs', import.meta.url), join(root, 'scripts/dev.mjs'));
  await writeFile(join(root, 'services/records/src/server.mjs'), `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    writeFileSync('api.pid', String(process.pid));
    createServer((_req, res) => res.end('ok')).listen(Number(process.env.RECORD_API_PORT), '127.0.0.1');
    if (process.env.FAIL_API) setTimeout(() => process.exit(7), 1500);
  `);
  await writeFile(join(root, 'services/records/src/worker.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync('worker.pid', String(process.pid)); setInterval(() => {}, 1000);
  `);
  await writeFile(join(root, 'apps/web/src/production-server.mjs'), `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    writeFileSync('production.json', JSON.stringify({ proxy: process.env.RECORD_API_URL, mode: process.env.NODE_ENV }));
    createServer((_req, res) => res.end('ok')).listen(Number(process.env.WEB_PORT), '127.0.0.1', () => writeFileSync('web-ready', String(process.pid)));
  `);
  await writeFile(join(root, 'bin/npm'), `#!/usr/bin/env node
    const { writeFileSync } = require('node:fs');
    const { spawn } = require('node:child_process');
    const args = process.argv.slice(2);
    writeFileSync('web-command.json', JSON.stringify({ args, proxy: process.env.RECORD_API_URL }));
    writeFileSync('web.pid', String(process.pid));
    const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '3000';
    const source = "const { writeFileSync } = require('node:fs'); const server = require('node:net').createServer(); " +
      "server.listen(Number(process.argv[1]), '0.0.0.0', () => writeFileSync('web-ready', String(process.pid)));";
    const child = spawn(process.execPath, ['-e', source, port], { stdio: 'inherit' });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
  `, { mode: 0o755 });
  const apiPort = env.RECORD_API_PORT || String(await freePort());
  let webPort = env.WEB_PORT || String(await freePort());
  while (!env.WEB_PORT && webPort === apiPort) webPort = String(await freePort());
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...args], { cwd: root,
    env: { ...process.env, RECORD_API_PORT: apiPort, WEB_PORT: webPort, RECORD_API_URL: '',
      PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })));
  t.after(async () => {
    child.kill('SIGTERM');
    let timer;
    await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 4000); })]);
    clearTimeout(timer);
    for (const file of ['api.pid', 'worker.pid', 'web.pid', 'web-ready']) {
      const pid = Number(await readFile(join(root, file), 'utf8').catch(() => ''));
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    child.kill('SIGKILL'); await rm(root, { recursive: true, force: true });
  });
  const read = file => readFile(join(root, file), 'utf8').catch(() => null);
  return { root, child, done, read, apiPort, webPort };
}

test('occupied API port fails before starting children and preserves its listener', async t => {
  const occupied = await listen(); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t, { RECORD_API_PORT: String(occupied.address().port) });
  const result = await f.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Record API.*端口.*占用/u);
  assert.doesNotMatch(result.stderr, /Unhandled|throw er|node:events/);
  assert.equal(await f.read('worker.pid'), null);
  assert.equal(await f.read('web-command.json'), null);
  assert.equal(occupied.listening, true);
});

test('occupied Web port is detected before API or worker starts', async t => {
  const occupied = await listen('0.0.0.0'); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t, { WEB_PORT: String(occupied.address().port) });
  const result = await f.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Web.*端口.*占用/u);
  assert.equal(await f.read('api.pid'), null);
  assert.equal(await f.read('worker.pid'), null);
});

test('a loopback-only Web listener also blocks a wildcard frontend launch', async t => {
  const occupied = await listen('127.0.0.1'); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = await fixture(t, { WEB_PORT: String(occupied.address().port) });
  const result = await Promise.race([f.done, delay(800).then(() => null)]);
  assert.ok(result, 'Launcher started children despite an existing loopback Web listener');
  assert.equal(result.code, 1); assert.match(result.stderr, /Web.*端口.*占用/u);
  assert.equal(await f.read('worker.pid'), null);
});

test('custom ports bind the frontend host and point its proxy at the selected API', async t => {
  const f = await fixture(t);
  await until(() => f.read('web-ready'));
  const command = JSON.parse(await f.read('web-command.json'));
  assert.deepEqual(command.args, ['run', 'dev', '-w', 'apps/web', '--', '--host', '0.0.0.0', '--port', f.webPort]);
  assert.equal(command.proxy, `http://127.0.0.1:${f.apiPort}`);
  f.child.kill('SIGTERM'); assert.equal((await f.done).code, 0);
  for (const port of [f.apiPort, f.webPort]) { const probe = await listen('0.0.0.0', Number(port)); await new Promise(resolve => probe.close(resolve)); }
});

test('a failed child produces a nonzero launcher exit and stops the other services', async t => {
  const f = await fixture(t, { FAIL_API: '1' });
  await until(() => f.read('web-ready'));
  const result = await f.done;
  assert.equal(result.code, 7);
  for (const port of [f.apiPort, f.webPort]) { const probe = await listen('0.0.0.0', Number(port)); await new Promise(resolve => probe.close(resolve)); }
});

test('an explicit API proxy URL is preserved', async t => {
  const proxy = 'http://127.0.0.1:9999';
  const f = await fixture(t, { RECORD_API_URL: proxy });
  await until(() => f.read('web-ready'));
  assert.equal(JSON.parse(await f.read('web-command.json')).proxy, proxy);
  f.child.kill('SIGTERM'); assert.equal((await f.done).code, 0);
});

for (const [name, env, message] of [
  ['invalid port', { RECORD_API_PORT: 'invalid' }, /RECORD_API_PORT 必须/u],
  ['identical ports', { RECORD_API_PORT: '39999', WEB_PORT: '39999' }, /必须使用不同端口/u]
]) test(`${name} fails without starting children`, async t => {
  const f = await fixture(t, env), result = await f.done;
  assert.equal(result.code, 1); assert.match(result.stderr, message);
  assert.equal(await f.read('api.pid'), null); assert.equal(await f.read('worker.pid'), null);
});

test('production keeps its server mode and uses the selected API proxy port', async t => {
  const f = await fixture(t, {}, ['--production']);
  await until(() => f.read('web-ready'));
  assert.deepEqual(JSON.parse(await f.read('production.json')), { proxy: `http://127.0.0.1:${f.apiPort}`, mode: 'production' });
  assert.equal(await f.read('web-command.json'), null);
  f.child.kill('SIGTERM'); assert.equal((await f.done).code, 0);
});

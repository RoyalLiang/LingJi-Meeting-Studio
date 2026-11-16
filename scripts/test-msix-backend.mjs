import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, rename, access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.platform, 'win32');
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const save = async (path, value) => {
  await writeFile(path + '.tmp', JSON.stringify(value));
  await rename(path + '.tmp', path);
};
await save(config.started, {pid: process.pid});
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await access(config.proceed); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'Parent did not verify the package identity');
    await delay(100);
  }
  const env = {...process.env, CLIENT_NODE_EXECUTABLE: process.execPath, CLIENT_BACKEND_ENTRY: join(config.backend, 'services/records/src/desktop-backend.mjs')};
  for (const [script, args] of [['test-standalone-package.mjs', [config.backendReport]], ['test-bundled-asr.mjs', [config.backend, config.asrReport]]]) {
    execFileSync(process.execPath, [join(config.sourceRoot, 'scripts', script), ...args], {cwd: config.sourceRoot, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024});
  }
  const asr = JSON.parse(await readFile(config.asrReport, 'utf8'));
  assert.equal(asr.nativeInference, true);
  await save(config.result, {ok: true, pid: process.pid});
} catch (error) {
  const message = String(error.stack || error).split('\n').filter(line => !/authorization|cookie|api.?key|password/i.test(line)).join('\n').slice(-6000);
  await save(config.result, {ok: false, error: message});
  process.exitCode = 1;
}

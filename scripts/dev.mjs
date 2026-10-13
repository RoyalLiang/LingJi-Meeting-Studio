import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const production = process.argv.includes('--production');
if (production) process.env.NODE_ENV = 'production';

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} 必须是 1～65535 的整数端口。`);
  return value;
}
async function checkPort({ name, host, port }) {
  if (host === '0.0.0.0') {
    const loopback = await checkPort({ name, host: '127.0.0.1', port });
    if (loopback) return loopback;
  }
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', error => resolve(error.code === 'EADDRINUSE'
      ? `${name} ${host}:${port} 端口已占用。` : `${name} ${host}:${port} 无法监听（${error.code}）。`));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(null)));
  });
}
async function main() {
  const apiPort = port('RECORD_API_PORT', 3030), webPort = port('WEB_PORT', 3000);
  if (apiPort === webPort) throw new Error('RECORD_API_PORT 和 WEB_PORT 必须使用不同端口。');
  const failures = (await Promise.all([
    checkPort({ name: 'Record API', host: '127.0.0.1', port: apiPort }),
    checkPort({ name: 'Web', host: production ? '127.0.0.1' : '0.0.0.0', port: webPort })
  ])).filter(Boolean);
  if (failures.length) {
    throw new Error(`${failures.join('\n[dev] ')}\n已有进程保持运行，本次未启动 API、worker 或 Web。\n请先在原启动终端按 Ctrl+C，或改用空闲端口，例如：\nRECORD_API_PORT=3031 WEB_PORT=3001 make`);
  }
  process.env.RECORD_API_PORT = String(apiPort);
  process.env.WEB_PORT = String(webPort);
  process.env.RECORD_API_URL ||= `http://127.0.0.1:${apiPort}`;
  const commands = [[process.execPath, ['services/records/src/server.mjs']], [process.execPath, ['services/records/src/worker.mjs']],
    production ? [process.execPath, ['apps/web/src/production-server.mjs']]
      : ['npm', ['run', 'dev', '-w', 'apps/web', '--', '--host', '0.0.0.0', '--port', String(webPort)]]];
  const children = [];
  let stopping = false;
  function signal(child, name) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) { if (error.code !== 'ESRCH') console.error(`[dev] 无法停止进程 ${child.pid}：${error.message}`); }
  }
  function stop(code = 0) {
    if (stopping) return;
    stopping = true; process.exitCode = code;
    children.forEach(child => signal(child, 'SIGTERM'));
    setTimeout(() => { children.forEach(child => signal(child, 'SIGKILL')); process.exit(code); }, 3000);
  }
  for (const [command, args] of commands) {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit', detached: process.platform !== 'win32' });
    children.push(child);
    child.once('error', error => { console.error(`[dev] ${command} 启动失败：${error.message}`); stop(1); });
    child.once('exit', (code, signal) => {
      if (stopping) return;
      console.error(`[dev] ${args[0]} 已退出（${signal || code}），正在停止本次启动的其他服务。`);
      stop(code || 1);
    });
  }
  process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());
}
try { await main(); } catch (error) { console.error(`[dev] ${error.message}`); process.exitCode = 1; }

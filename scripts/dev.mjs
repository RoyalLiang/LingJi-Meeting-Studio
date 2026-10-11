import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const production = process.argv.includes('--production');
const commands = [[process.execPath, ['services/records/src/server.mjs']], [process.execPath, ['services/records/src/worker.mjs']],
  production ? [process.execPath, ['apps/web/src/production-server.mjs']] : ['npm', ['run', 'dev', '-w', 'apps/web']]];
const children = commands.map(([command, args]) => spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); setTimeout(() => { children.forEach(child => child.kill('SIGKILL')); process.exit(code); }, 3000).unref(); }
for (const child of children) child.on('exit', code => { if (!stopping) stop(code || 0); });
process.once('SIGINT', () => stop()); process.once('SIGTERM', () => stop());

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

export const LOCAL_ASR_MODEL = 'sensevoice-small-2024-07-17-int8';
export const localAsrConfigured = config => Boolean(config.LINGJI_LOCAL_ASR_DIR && existsSync(join(config.LINGJI_LOCAL_ASR_DIR, 'manifest.json')));
const worker = fileURLToPath(new URL('./local-asr-worker.mjs', import.meta.url));
const clients = new Map();
const failure = code => new DomainError(code, 503);

export async function verifyLocalAsrAssets(directory) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
  catch { throw failure('local_asr_assets_missing'); }
  requireThat(manifest.model === LOCAL_ASR_MODEL && manifest.runtime === '1.13.8' && Array.isArray(manifest.files) && manifest.files.length > 5, 'local_asr_assets_invalid', 503);
  requireThat(manifest.platform === process.platform && manifest.arch === process.arch && Array.isArray(manifest.nativeFiles) && manifest.nativeFiles.length >= 3, 'local_asr_assets_invalid', 503);
  const required = ['sensevoice/model.int8.onnx', 'sensevoice/tokens.txt', 'silero_vad.onnx'];
  requireThat(required.every(name => manifest.files.some(file => file.path === name)), 'local_asr_assets_invalid', 503);
  for (const path of manifest.nativeFiles) {
    requireThat(typeof path === 'string' && /^node_modules\/sherpa-onnx-[a-z0-9-]+\/[^/\\]+\.(node|dylib|dll)$/.test(path), 'local_asr_assets_invalid', 503);
    try { requireThat((await lstat(join(directory, path))).isFile(), 'local_asr_assets_invalid', 503); }
    catch { throw failure('local_asr_assets_missing'); }
  }
  for (const file of manifest.files) {
    requireThat(typeof file.path === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'local_asr_assets_invalid', 503);
    const path = resolve(directory, file.path), rel = relative(directory, path);
    requireThat(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'local_asr_assets_invalid', 503);
    try {
      const stat = await lstat(path);
      requireThat(stat.isFile() && stat.size === file.bytes, 'local_asr_assets_invalid', 503);
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path)) hash.update(bytes);
      requireThat(hash.digest('hex') === file.sha256, 'local_asr_assets_invalid', 503);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw failure('local_asr_assets_missing');
    }
  }
  return manifest;
}

// Own the native process behind one request interface. A crash cannot terminate
// the record backend, and the event loop never performs native inference.
export class LocalAsrClient {
  #child; #starting; #verified = false; #pending = new Map(); #sequence = 0;
  #queue = Promise.resolve(); #queued = 0; #stopped = false; #idle;
  constructor(directory, { workerPath = worker, verify = verifyLocalAsrAssets, timeoutMs = 120000, idleMs = 180000 } = {}) {
    this.directory = directory; this.workerPath = workerPath; this.verify = verify;
    this.timeoutMs = timeoutMs; this.idleMs = idleMs;
  }
  async #start() {
    if (this.#stopped) throw failure('local_asr_shutdown');
    if (this.#child && !this.#starting) return this.#child;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      if (!this.#verified) { await this.verify(this.directory); this.#verified = true; }
      if (this.#stopped) throw failure('local_asr_shutdown');
      const env = { ...process.env };
      if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = join(this.directory, 'node_modules', `sherpa-onnx-darwin-${process.arch}`);
      const child = spawn(process.execPath, [this.workerPath, this.directory], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.#child = child;
      return new Promise((resolveStart, rejectStart) => {
        let buffer = '', ready = false;
        const decoder = new StringDecoder('utf8');
        const timer = setTimeout(() => abort('local_asr_timeout'), this.timeoutMs); timer.unref();
        const abort = code => {
          clearTimeout(timer);
          if (this.#child !== child) return;
          this.#child = undefined;
          rejectStart(failure(code));
          for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(failure(code)); }
          this.#pending.clear(); child.kill();
        };
        child.once('error', () => abort('local_asr_unavailable'));
        child.once('close', () => abort(this.#stopped ? 'local_asr_shutdown' : 'local_asr_unavailable'));
        child.stdin.on('error', () => abort('local_asr_unavailable'));
        child.stderr.on('data', () => {}); // Drain native diagnostics; never log audio/text.
        child.stdout.on('data', bytes => {
          buffer += decoder.write(bytes);
          if (buffer.length > 1000000) return abort('local_asr_invalid_response');
          for (;;) {
            const end = buffer.indexOf('\n'); if (end < 0) break;
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let message;
            try { message = JSON.parse(line); } catch { return abort('local_asr_invalid_response'); }
            if (!ready) {
              if (message.protocol !== 1 || message.ready !== true || message.model !== LOCAL_ASR_MODEL) return abort('local_asr_invalid_response');
              ready = true; clearTimeout(timer); resolveStart(child); continue;
            }
            const pending = this.#pending.get(message.id);
            if (!pending) return abort('local_asr_invalid_response');
            if (!message.error && (typeof message.text !== 'string' || message.text.length > 8000)) return abort('local_asr_invalid_response');
            this.#pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(failure('local_asr_inference_failed'));
            else pending.resolve(message.text);
          }
        });
      });
    })();
    try { return await this.#starting; }
    finally { this.#starting = undefined; }
  }
  transcribe(bytes) {
    requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 960000 && bytes.length % 2 === 0, 'invalid_funasr_audio', 422);
    if (this.#stopped) return Promise.reject(failure('local_asr_shutdown'));
    clearTimeout(this.#idle); this.#queued++;
    const result = this.#queue.then(async () => {
      const child = await this.#start();
      if (this.#stopped) throw failure('local_asr_shutdown');
      const id = ++this.#sequence;
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          if (this.#child === child) this.#child = undefined;
          child.kill(); this.#pending.delete(id); rejectRequest(failure('local_asr_timeout'));
        }, this.timeoutMs); timer.unref();
        this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        child.stdin.write(JSON.stringify({ id, pcm: bytes.toString('base64') }) + '\n', error => {
          if (error) { clearTimeout(timer); this.#pending.delete(id); rejectRequest(failure('local_asr_unavailable')); }
        });
      });
    });
    this.#queue = result.catch(() => {});
    return result.finally(() => {
      this.#queued--;
      if (!this.#queued && !this.#stopped) {
        this.#idle = setTimeout(() => { const child = this.#child; this.#child = undefined; child?.kill(); }, this.idleMs); this.#idle.unref();
      }
    });
  }
  async close() {
    this.#stopped = true; clearTimeout(this.#idle);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(failure('local_asr_shutdown')); }
    this.#pending.clear();
    const child = this.#child;
    if (child) {
      child.kill();
      await Promise.race([new Promise(done => child.once('close', done)), new Promise(done => { const timer = setTimeout(done, 1000); timer.unref(); })]);
    }
  }
}

let accepting = true;
// Reopened only by a newly started desktop backend.
export function openLocalAsr() { accepting = true; }
export async function transcribeLocalAsr(bytes, config) {
  requireThat(accepting, 'local_asr_shutdown', 503);
  requireThat(localAsrConfigured(config), 'local_asr_assets_missing', 503);
  const directory = resolve(config.LINGJI_LOCAL_ASR_DIR);
  if (!clients.has(directory)) clients.set(directory, new LocalAsrClient(directory));
  return clients.get(directory).transcribe(bytes);
}
export async function closeLocalAsr() {
  accepting = false;
  const active = [...clients.values()]; clients.clear();
  await Promise.all(active.map(client => client.close()));
}

export function bundledAsrDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../local-asr');
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { normalizedVoice, validDiarization } from './local-speakers.mjs';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

export const LOCAL_ASR_MODEL = 'sensevoice-small-2024-07-17-int8';
export const LOCAL_SPEAKER_MODEL = 'pyannote3-eres2net-base-512-v1';
export const LOCAL_STREAMING_ASR_MODEL = 'zipformer-small-bilingual-zh-en-2023-02-16-int8-chunk32';
export const localAsrConfigured = config => Boolean(config.LINGJI_LOCAL_ASR_DIR && existsSync(join(config.LINGJI_LOCAL_ASR_DIR, 'manifest.json')));
const worker = fileURLToPath(new URL('./local-asr-worker.mjs', import.meta.url));
const clients = new Map();
const capabilityCache = new Map();
function localModels(config) {
  if (!localAsrConfigured(config)) return {};
  const path = join(config.LINGJI_LOCAL_ASR_DIR, 'manifest.json');
  try {
    const version = statSync(path).mtimeMs, cached = capabilityCache.get(path);
    if (cached?.version === version) return cached.models;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const models = { streaming: manifest.streamingModel?.model, speakers: manifest.speakerModels?.model };
    if (capabilityCache.size >= 32) capabilityCache.delete(capabilityCache.keys().next().value);
    capabilityCache.set(path, { version, models }); return models;
  } catch { return {}; }
}
export const localStreamingAsrConfigured = config => localModels(config).streaming === LOCAL_STREAMING_ASR_MODEL;
export const localSpeakersConfigured = config => localModels(config).speakers === LOCAL_SPEAKER_MODEL;

const failure = code => new DomainError(code, 503);

export async function verifyLocalAsrAssets(directory, { model = LOCAL_ASR_MODEL } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
  catch { throw failure('local_asr_assets_missing'); }
  requireThat(manifest.model === LOCAL_ASR_MODEL && manifest.runtime === '1.13.8' && Array.isArray(manifest.files) && manifest.files.length > 5, 'local_asr_assets_invalid', 503);
  requireThat(manifest.platform === process.platform && manifest.arch === process.arch && Array.isArray(manifest.nativeFiles) && manifest.nativeFiles.length >= 3, 'local_asr_assets_invalid', 503);
  const streaming = model === LOCAL_STREAMING_ASR_MODEL, speakers = model === LOCAL_SPEAKER_MODEL;
  const required = speakers ? ['speakers/segmentation.int8.onnx', 'speakers/embedding.onnx'] : streaming ? ['zipformer/encoder-epoch-99-avg-1.int8.onnx', 'zipformer/decoder-epoch-99-avg-1.int8.onnx', 'zipformer/joiner-epoch-99-avg-1.int8.onnx', 'zipformer/tokens.txt'] : ['sensevoice/model.int8.onnx', 'sensevoice/tokens.txt', 'silero_vad.onnx'];
  requireThat(required.every(name => manifest.files.some(file => file.path === name)), 'local_asr_assets_invalid', 503);
  for (const path of manifest.nativeFiles) {
    requireThat(typeof path === 'string' && /^node_modules\/sherpa-onnx-[a-z0-9-]+\/[^/\\]+\.(node|dylib|dll|so(?:\.\d+)*)$/.test(path), 'local_asr_assets_invalid', 503);
    try { requireThat((await lstat(join(directory, path))).isFile(), 'local_asr_assets_invalid', 503); }
    catch { throw failure('local_asr_assets_missing'); }
  }
  for (const file of manifest.files) {
    requireThat(typeof file.path === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'local_asr_assets_invalid', 503);
    const path = resolve(directory, file.path), rel = relative(directory, path);
    requireThat(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'local_asr_assets_invalid', 503);
    if (file.path.startsWith('zipformer/') && !streaming || (file.path.startsWith('speakers/') || file.path.startsWith('licenses/speaker-')) && !speakers || (file.path.startsWith('sensevoice/') || file.path === 'silero_vad.onnx') && (streaming || speakers)) continue;
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
  constructor(directory, { workerPath = worker, model = LOCAL_ASR_MODEL, verify = verifyLocalAsrAssets, timeoutMs = 120000, idleMs = 180000 } = {}) {
    this.directory = directory; this.workerPath = workerPath; this.model = model; this.verify = verify;
    this.timeoutMs = timeoutMs; this.idleMs = idleMs;
  }
  async #start() {
    if (this.#stopped) throw failure('local_asr_shutdown');
    if (this.#child && !this.#starting) return this.#child;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      if (!this.#verified) { await this.verify(this.directory, { model: this.model }); this.#verified = true; }
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
              if (message.protocol !== 1 || message.ready !== true || message.model !== this.model) return abort('local_asr_invalid_response');
              ready = true; clearTimeout(timer); resolveStart(child); continue;
            }
            const pending = this.#pending.get(message.id);
            if (!pending) return abort('local_asr_invalid_response');
            if (!message.error && (typeof message.text !== 'string' || message.text.length > 8000 || (message.language !== undefined && !['zh', 'en', 'ja', 'ko', 'yue'].includes(message.language)))) return abort('local_asr_invalid_response');
            if (!message.error && (message.diarization !== undefined && (!pending.diarize || !validDiarization(message.diarization, pending.durationMs)) || pending.diarize && message.diarization === undefined || message.embedding !== undefined && (!pending.embedding || !normalizedVoice(message.embedding)) || pending.embedding && message.embedding === undefined || message.diarizationError !== undefined && message.diarizationError !== 'local_diarization_unavailable')) return abort('local_asr_invalid_response');
            if (!message.error && pending.context && (message.startSample !== pending.context.sampleOffset || message.endSample !== pending.context.endSample)) return abort('local_asr_invalid_response');
            this.#pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(failure('local_asr_inference_failed'));
            else pending.resolve({ text: message.text, ...(message.diarization ? { diarization: message.diarization } : {}), ...(message.embedding ? { embedding: message.embedding } : {}), ...(message.diarizationError ? { diarizationError: message.diarizationError } : {}), ...(message.language ? { language: message.language } : {}), ...(Number.isSafeInteger(message.startSample)&&Number.isSafeInteger(message.endSample)&&message.startSample>=0&&message.endSample>=message.startSample?{startSample:message.startSample,endSample:message.endSample}:{}) });
          }
        });
      });
    })();
    try { return await this.#starting; }
    finally { this.#starting = undefined; }
  }
  transcribe(bytes, { metadata = false, context, diarize = false, embedding = false } = {}) {
    requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 960000 && bytes.length % 2 === 0, 'invalid_funasr_audio', 422);
    requireThat(typeof diarize === 'boolean' && typeof embedding === 'boolean' && !(diarize && embedding), 'invalid_local_asr_audio', 422);
    if (context) requireThat(typeof context.key === 'string' && context.key.length > 0 && context.key.length <= 200 && Number.isSafeInteger(context.sampleOffset) && context.sampleOffset >= 0 && Number.isSafeInteger(context.sampleOffset + bytes.length / 2) && typeof context.final === 'boolean', 'invalid_local_asr_audio', 422);
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
        this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, diarize, embedding, durationMs: bytes.length / 32, ...(context ? { context: { sampleOffset: context.sampleOffset, endSample: context.sampleOffset + bytes.length / 2 } } : {}) });
        child.stdin.write(JSON.stringify({ id, pcm: bytes.toString('base64'), ...(diarize ? { diarize: true } : {}), ...(embedding ? { embedding: true } : {}),...(context?{context}:{}) }) + '\n', error => {
          if (error) { clearTimeout(timer); this.#pending.delete(id); rejectRequest(failure('local_asr_unavailable')); }
        });
      });
    });
    this.#queue = result.catch(() => {});
    return result.then(value => metadata ? value : value.text).finally(() => {
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
const speakerRetryAt = new Map();
function localClient(directory, speakers = false) {
  requireThat(accepting, 'local_asr_shutdown', 503);
  const key = speakers ? directory + ':speakers' : directory;
  if (!clients.has(key)) clients.set(key, new LocalAsrClient(directory, speakers ? { workerPath: fileURLToPath(new URL('./local-speaker-worker.mjs', import.meta.url)), model: LOCAL_SPEAKER_MODEL, timeoutMs: 8000 } : {}));
  return clients.get(key);
}
export async function transcribeLocalAsr(bytes, config, options = {}) {
  requireThat(accepting, 'local_asr_shutdown', 503);
  requireThat(localAsrConfigured(config), 'local_asr_assets_missing', 503);
  const directory = resolve(config.LINGJI_LOCAL_ASR_DIR);
  if (options.embedding) return localClient(directory, true).transcribe(bytes, { metadata: true, embedding: true });
  if (!options.diarize) return localClient(directory).transcribe(bytes, options);
  let slices;
  try {
    requireThat((speakerRetryAt.get(directory) || 0) <= Date.now(), 'local_asr_unavailable', 503);
    const identified = (await localClient(directory, true).transcribe(bytes, { metadata: true, diarize: true })).diarization;
    slices = []; let offset = 0;
    for (const slice of identified) {
      if (slice.start > offset) slices.push({ start: offset, end: slice.start, overlap: false });
      slices.push(slice); offset = slice.end;
    }
    if (offset < bytes.length / 2) slices.push({ start: offset, end: bytes.length / 2, overlap: false });
    requireThat(slices.length <= 64, 'local_asr_invalid_response', 503);
    speakerRetryAt.delete(directory);
  } catch {
    if (speakerRetryAt.size >= 32) speakerRetryAt.delete(speakerRetryAt.keys().next().value);
    speakerRetryAt.set(directory, Date.now() + 30000);
    const result = await localClient(directory).transcribe(bytes, { metadata: true });
    return options.metadata ? { ...result, diarizationError: 'local_diarization_unavailable' } : result.text;
  }
  if (!slices.length) return localClient(directory).transcribe(bytes, { metadata: options.metadata });
  const turns = [];
  for (const slice of slices) {
    const result = await localClient(directory).transcribe(bytes.subarray(slice.start * 2, slice.end * 2), { metadata: true });
    if (result.text) turns.push({ ...result, startMs: slice.start / 16, endMs: slice.end / 16, overlap: slice.overlap, ...(slice.embedding ? { embedding: slice.embedding } : {}) });
  }
  if (!turns.length) return localClient(directory).transcribe(bytes, { metadata: options.metadata });
  const result = { text: turns.map(turn => turn.text).join(' '), turns, ...(turns[0].language ? { language: turns[0].language } : {}) };
  return options.metadata ? result : result.text;
}

export function transcribeLocalStreaming(bytes,config,context){
  requireThat(accepting,'local_asr_shutdown',503);requireThat(localStreamingAsrConfigured(config),'local_asr_assets_missing',503);
  const directory=resolve(config.LINGJI_LOCAL_ASR_DIR),key=directory+':streaming';
  if(!clients.has(key))clients.set(key,new LocalAsrClient(directory,{workerPath:fileURLToPath(new URL('./local-streaming-asr-worker.mjs',import.meta.url)),model:LOCAL_STREAMING_ASR_MODEL,timeoutMs:5000}));
  return clients.get(key).transcribe(bytes,{metadata:true,context});
}
export async function closeLocalAsr() {
  accepting = false;
  const active = [...clients.values()]; clients.clear(); speakerRetryAt.clear();
  await Promise.all(active.map(client => client.close()));
}

export function bundledAsrDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../local-asr');
}

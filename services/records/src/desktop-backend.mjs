import {queueLearningReview} from '../../../packages/records/src/learning.mjs';
// Private bundled runtime entry; never imports a developer .env or starts Vite.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, opendir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRepository } from './repository.mjs';
import { createRecordServer } from './server.mjs';
import { runCycle } from './worker.mjs';
import { closeSpeakerStreams } from './speaker-streams.mjs';
import { emit } from '../../../packages/records/src/record.mjs';

export async function recoverTemporaryAudio(root) {
  let pending;
  try { pending = await opendir(join(root, 'audio', '.pending')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (pending) {
    let removed = 0;
    for await (const file of pending) if (/^\.tmp-[a-f0-9-]{36}$/.test(file.name)) {
      await rm(join(root, 'audio', '.pending', file.name), { force: true });
      if (++removed >= 10000) break;
    }
  }
  let directories;
  try { directories = await opendir(join(root, 'audio')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let checked = 0;
  for await (const directory of directories) {
    if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/.test(directory.name)) continue;
    for await (const file of await opendir(join(root, 'audio', directory.name))) {
      if (/^\.tmp-[a-f0-9-]{36}$/.test(file.name)) await rm(join(root, 'audio', directory.name, file.name), { force: true });
      if (++checked >= 10000) return;
    }
  }
}

export async function recoverLocalWork(repo) {
  for (const record of await repo.list()) {
    if (record.deleted) continue;
    if(record.capture==='completed' && process.env.RECORD_LEARNING_ENABLED!=='false')await repo.change(record.id,r=>{if(queueLearningReview(r,true))emit(r,'learning.queued');});
    const interrupted = record.jobs.some(job => job.status === 'running') || record.chunks.some(chunk => chunk.lease) || record.intentLease || record.sources.some(source => source.asr?.state === 'running' || source.asr?.lease) || record.segments.some(segment => segment.translationLease);
    if(record.learning?.status==='running')await repo.change(record.id,r=>{r.learning.status='queued';delete r.learning.lease;delete r.learning.fence;emit(r,'learning.recovered');});
    if (!interrupted) continue;
    await repo.change(record.id, r => {
      for (const chunk of r.chunks) if (chunk.lease) { delete chunk.lease; delete chunk.fence; if (chunk.state !== 'done') chunk.state = 'pending'; }
      for (const job of r.jobs) if (job.status === 'running') { job.status = 'queued'; delete job.lease; delete job.fence; }
      for (const source of r.sources) if (source.asr) { delete source.asr.lease; delete source.asr.fence; }
      delete r.intentLease;
      for (const segment of r.segments) { delete segment.translationLease; delete segment.translationFence; }
      emit(r, 'client.recovered');
    });
  }
  for(const job of await repo.list('learning-training'))if(job.status==='running')await repo.change(job.id,state=>{state.status='queued';state.sequence++;state.round='r'+String(state.sequence).padStart(3,'0');delete state.lease;delete state.fence;});
  for (const job of await repo.list('workspace-analysis')) if (job.status === 'running') {
    await repo.change(job.id, value => { value.status = 'queued'; delete value.lease; delete value.fence; });
  }
}

export async function startDesktopBackend({ root, port = 0, workers = true } = {}) {
  if (!root) throw new Error('client_data_root_required');
  process.umask(0o077);
  process.env.NODE_ENV = 'desktop';
  process.env.RECORD_DEV_ACCOUNT = 'off';
  process.env.RECORD_CONFIG_ADMIN = 'local@device.invalid';
  // A generated persistent session key stays under the client root, not in env.
  for (const key of ['RECORD_DATABASE_URL', 'RECORD_S3_BUCKET', 'RECORD_SESSION_SECRET', 'RECORD_INVITE_CODE', 'RECORD_PUBLIC_ORIGIN']) delete process.env[key];
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Native has acquired the client lock; no previous owner is still writing.
  await recoverTemporaryAudio(root);
  const db = new DatabaseSync(':memory:');
  const sqlite = db.prepare('SELECT sqlite_version() version').get().version;
  db.exec('CREATE VIRTUAL TABLE verify_fts USING fts5(content)'); db.close();
  const version = sqlite.split('.').map(Number);
  if (version[0] < 3 || (version[0] === 3 && (version[1] < 51 || (version[1] === 51 && version[2] < 3)))) throw new Error('client_sqlite_runtime_too_old');
  const repo = await createRepository({ root, databaseUrl: '', s3: { bucket: '' }, compressAggregates: true, compressAudio: true });
  await recoverLocalWork(repo);
  const app = await createRecordServer({ repo, port, host: '127.0.0.1', seedDevelopment: false, localAccount: true });
  const address = await app.start();
  const session = await app.localSession();
  const state = { pid: process.pid, url: `http://127.0.0.1:${address.port}`, node: process.version, sqlite, startedAt: new Date().toISOString() };
  await writeFile(join(root, 'runtime-state.json'), JSON.stringify(state) + '\n', { mode: 0o600 });
  let stopping = false;
  const loops = workers ? ['audio', 'minutes', 'translation', 'intents', 'workspace', 'learning'].map(lane => (async () => {
    while (!stopping) {
      try { await runCycle(repo, {}, { lane }); } catch (error) { console.error('[client-worker]', error.code || error.name); }
      if (!stopping) await new Promise(resolve => setTimeout(resolve, lane === 'audio' ? 100 : 250));
    }
  })()) : [];
  return { repo, sqlite, url: `http://127.0.0.1:${address.port}`, session,
    async stop() { stopping = true; for (const record of await repo.list()) closeSpeakerStreams(repo, record.id); await Promise.all(loops); await app.stop(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let backend;
  try {
    if (!process.argv[2]) throw new Error('client_data_root_required');
    backend = await startDesktopBackend({ root: resolve(process.argv[2]), workers: true });
    console.log(JSON.stringify({ protocol: 1, url: backend.url, cookie: backend.session, sqlite: backend.sqlite, nonce: randomBytes(8).toString('hex') }));
  } catch (error) { console.error('[client-backend]', error.code || error.message || error.name); process.exit(1); }
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(0), 3000); deadline.unref();
    try { await backend.stop(); } finally { process.exit(0); }
  };
  process.stdin.resume(); process.stdin.once('end', stop);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

// Synthetic backend readiness only: no existing client data, audio devices, or providers.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord } from '../packages/records/src/record.mjs';
import { queueLearningReview } from '../packages/records/src/learning.mjs';
import { startDesktopBackend, recoverLocalWork } from '../services/records/src/desktop-backend.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 21)) throw new Error('Use Node 24.21 or newer with SQLite FTS5 support.');
const root = await mkdtemp(join(tmpdir(), 'lingji-startup-benchmark-'));
let repo;
try {
  repo = await createRepository({ root, databaseUrl: '', s3: { bucket: '' }, compressAggregates: true });
  for (let i = 0; i < 100; i++) {
    const record = createRecord('fixture-owner', { title: `合成历史会议 ${i}` });
    record.capture = 'completed'; record.transcriptRevision = 1;
    record.segments = Array.from({ length: 120 }, (_, n) => ({ id: `s${n}`, revision: 1, sourceId: 'text-import', startMs: n * 2000, endMs: n * 2000 + 1800,
      text: '这是用于启动测量的合成会议内容，不含真实会议信息。'.repeat(6) }));
    queueLearningReview(record, true); record.learning.status = 'ready';
    await repo.insert(record);
  }
  let recoveryWrites = 0;
  const change = repo.change.bind(repo);
  repo.change = (...args) => { recoveryWrites++; return change(...args); };
  const start = performance.now(); await recoverLocalWork(repo);
  const recoveryMs = performance.now() - start;
  await repo.close(); repo = undefined;
  const readinessMs = [];
  for (let n = 0; n < 3; n++) {
    const start = performance.now(), backend = await startDesktopBackend({ root, workers: false });
    readinessMs.push(Math.round(performance.now() - start));
    await backend.stop();
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    meetings: 100, segmentsPerMeeting: 120, recoveryWrites, recoveryMs: Math.round(recoveryMs), readinessMs,
    medianReadinessMs: [...readinessMs].sort((a,b) => a-b)[1], workers: false, realAudioDevices: false, realProviders: false,
    scope: 'backend readiness on synthetic history; excludes native window, WebView and full cold startup' }, null, 2));
} finally {
  await repo?.close(); await rm(root, { recursive: true, force: true });
}

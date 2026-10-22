import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord } from '../packages/records/src/record.mjs';

test('new meetings stay above older meetings after background changes, search, and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingji-order-'));
  let repo;
  try {
    repo = await createRepository({ root, databaseUrl: '' });
    const older = createRecord('owner', { title:'项目旧会议' }), newer = createRecord('owner', { title:'项目新会议' });
    older.createdAt = '2026-01-01T00:00:00.000Z'; older.updatedAt = '2026-10-22T23:00:00.000Z';
    newer.createdAt = '2026-10-22T09:00:00.000Z'; newer.updatedAt = newer.createdAt;
    await repo.insert(older); await repo.insert(newer);
    const check = async () => {
      assert.deepEqual((await repo.listSummaries('owner')).map(r=>r.id), [newer.id, older.id]);
      assert.deepEqual((await repo.listSummaries('owner','inbox','项目')).map(r=>r.id), [newer.id, older.id]);
    };
    await check();
    await repo.change(older.id, r => { r.title = '项目旧会议纪要已更新'; });
    await check(); await repo.close();
    repo = await createRepository({ root, databaseUrl: '' }); await check();
  } finally { await repo?.close(); await rm(root, { recursive:true, force:true }); }
});

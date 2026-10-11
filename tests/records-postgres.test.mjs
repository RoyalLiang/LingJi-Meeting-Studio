import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord } from '../packages/records/src/record.mjs';
const databaseUrl = process.env.RECORD_TEST_DATABASE_URL;
test('Postgres row locking and restart durability', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Use a dedicated test database');
  const root = await mkdtemp(join(tmpdir(), 'tts-postgres-')); let repo = await createRepository({ root, databaseUrl });
  const record = createRecord('integration-test-only');
  try {
    await repo.insert(record);
    await Promise.all(Array.from({ length: 10 }, () => repo.change(record.id, r => { r.notesRevision++; })));
    await repo.close(); repo = await createRepository({ root, databaseUrl });
    assert.equal((await repo.get(record.id)).notesRevision, 10);
  } finally {
    const { Pool } = await import('pg'); const cleanup = new Pool({ connectionString: databaseUrl });
    await cleanup.query("DELETE FROM record_aggregates WHERE id=$1 AND data->>'owner'='integration-test-only'", [record.id]);
    await cleanup.end(); await repo.close(); await rm(root, { recursive: true });
  }
});

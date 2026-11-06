import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord } from '../packages/records/src/record.mjs';

test('SQLite startup waits for the previous process to release its database lock', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-startup-lock-'));
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('CREATE TABLE startup_lock(value TEXT); BEGIN EXCLUSIVE');
    process.send('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, 750);
  `, join(root, 'records.sqlite')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(holder, 'exit');
  let repo;
  try {
    assert.equal((await once(holder, 'message'))[0], 'locked');
    repo = await createRepository({ root, databaseUrl: '', s3: { bucket: '' } });
    const record = createRecord('startup-owner');
    await repo.insert(record);
    assert.equal((await repo.get(record.id)).owner, 'startup-owner');
    assert.equal((await exited)[0], 0);
  } finally {
    await repo?.close();
    if (holder.exitCode == null) holder.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

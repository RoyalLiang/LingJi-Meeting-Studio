import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError, requireThat } from '../../../packages/records/src/record.mjs';

export async function createRepository(options = {}) {
  const root = resolve(options.root || process.env.RECORD_DATA_DIR || '.data/records');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let db, pool;
  const databaseUrl = options.databaseUrl ?? process.env.RECORD_DATABASE_URL;
  if (databaseUrl) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: databaseUrl });
    await pool.query('CREATE TABLE IF NOT EXISTS record_aggregates (id text PRIMARY KEY, data jsonb NOT NULL)');
  } else {
    const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(join(root, 'records.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS aggregates (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }
  const decode = row => row ? typeof row.data === 'string' ? JSON.parse(row.data) : row.data : null;
  return {
    root, backend: pool ? 'postgres' : 'sqlite',
    async get(id) { return decode(pool ? (await pool.query('SELECT data FROM record_aggregates WHERE id=$1', [id])).rows[0]
      : db.prepare('SELECT data FROM aggregates WHERE id=?').get(id)); },
    async list(kind = 'record') {
      const rows = pool ? (await pool.query("SELECT data FROM record_aggregates WHERE data->>'kind'=$1", [kind])).rows
        : db.prepare("SELECT data FROM aggregates WHERE json_extract(data, '$.kind')=?").all(kind);
      return rows.map(decode);
    },
    async insert(value) {
      try {
        if (pool) await pool.query('INSERT INTO record_aggregates(id,data) VALUES($1,$2)', [value.id, JSON.stringify(value)]);
        else db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)').run(value.id, JSON.stringify(value));
      } catch (error) { if (error.code === '23505' || error.code?.startsWith('ERR_SQLITE')) throw new DomainError('already_exists'); throw error; }
      return value;
    },
    async change(id, mutate) {
      const client = pool ? await pool.connect() : null;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        const value = decode(client ? (await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE', [id])).rows[0]
          : db.prepare('SELECT data FROM aggregates WHERE id=?').get(id));
        requireThat(value, 'not_found', 404);
        const result = mutate(value);
        requireThat(!(result instanceof Promise), 'transaction_must_be_synchronous', 500);
        if (client) await client.query('UPDATE record_aggregates SET data=$2 WHERE id=$1', [id, JSON.stringify(value)]);
        else db.prepare('UPDATE aggregates SET data=? WHERE id=?').run(JSON.stringify(value), id);
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
        return structuredClone(result ?? value);
      } catch (error) { if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK'); throw error; }
      finally { client?.release(); }
    },
    async putAudio(recordId, bytes) {
      requireThat(/^[a-f0-9-]{36}$/.test(recordId), 'invalid_record_id', 400);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const directory = join(root, 'audio', recordId); await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, hash);
      try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        requireThat(createHash('sha256').update(await readFile(file)).digest('hex') === hash, 'audio_object_corrupt', 500);
      }
      return { digest: hash, object: `${recordId}/${hash}` };
    },
    async readAudio(object) {
      requireThat(/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(object), 'invalid_object', 400);
      return readFile(join(root, 'audio', object));
    },
    async cleanAudio(recordId, liveObjects = new Set(), olderThan = Infinity) {
      requireThat(/^[a-f0-9-]{36}$/.test(recordId), 'invalid_record_id', 400);
      const directory = join(root, 'audio', recordId);
      const entries = await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      for (const file of entries) if (/^[a-f0-9]{64}$/.test(file) && !liveObjects.has(`${recordId}/${file}`) && (await stat(join(directory, file))).mtimeMs < olderThan) await rm(join(directory, file));
    },
    async close() { if (pool) await pool.end(); else db.close(); }
  };
}

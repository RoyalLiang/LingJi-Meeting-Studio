import { analysisInput } from '../../../packages/records/src/workspaces.mjs';
import {flushAudioObject} from './audio-storage-sync.mjs';
import {learningWorkAt} from '../../../packages/records/src/learning.mjs';
import { cursorKey, deriveProjection, visibleSnapshot } from './projections.mjs';
import { automaticMinutesAt } from '../../../packages/records/src/automation.mjs';
import { mkdir, open, readFile, readdir, rm, stat, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, requireThat, needsMinutesAudio } from '../../../packages/records/src/record.mjs';
import { createS3Objects } from './s3.mjs';
import { telemetry } from './telemetry.mjs';
import { encodeStorage, decodeStorage } from './storage-codec.mjs';

function traceWrite(value){if(telemetry.enabled)telemetry.event('db.write',{recordId:value.id,bytes:Buffer.byteLength(JSON.stringify(value))});}
function schedule(value) {
  if (value.kind !== 'record') return;
  const now = Date.now();
  if (value.deleted) { value.nextWorkAt = value.cleanup === 'completed' ? (value.cleanupAt || 0) + 600000 : now; return; }
  const times = [learningWorkAt(value, now), ...(value.learning?.enabled && value.capture==='completed' && value.learning.revision!==value.transcriptRevision ? [now] : []), automaticMinutesAt(value, now), Date.parse(value.deleteAt), (value.gcAt || 0) + 3600000];
  if (!value.retainAudio && !value.audioPurged && value.capture === 'completed' && !needsMinutesAudio(value)) times.push(now);
  if (value.realtimeAudioConsent && value.autoMinutes?.enabled && value.realtime?.state === 'blocked') times.push(Math.max(value.realtime.retryAt || 0, now));
  for (const source of value.sources) {
    if (source.asr?.state === 'running') times.push(now+250);
    if (source.asr?.state === 'failed' && source.asr.attempts<5) times.push(Math.max(source.asr.retryAt||0,now));
  }
  const watermarks = new Map(value.sources.map(source => [source.id, source.watermark]));
  const firstPending = new Map();
  for (const chunk of value.chunks) if (chunk.state !== 'done') firstPending.set(chunk.sourceId, Math.min(firstPending.get(chunk.sourceId) ?? Infinity, chunk.sequence));
  for (const chunk of value.chunks) {
    if (chunk.expired) continue;
    if (!value.retainAudio) times.push((chunk.acceptedAt || Date.parse(value.createdAt)) + 86400000);
    if (chunk.state === 'done') continue;
    if (chunk.attempts < 5 && watermarks.get(chunk.sourceId) >= chunk.sequence
      && firstPending.get(chunk.sourceId) === chunk.sequence) {
      times.push(Math.max(chunk.lease || 0, chunk.retryAt || 0, now));
    }
  }
  if (value.segments.length && value.insights?.transcriptRevision !== value.transcriptRevision) times.push(Math.max(value.intentLease || 0, value.intentRetryAt || 0, now));
  if (value.translationTarget) for (const s of value.segments) if (s.translationLanguage !== value.translationTarget && (s.translationAttempts || 0) < 3) times.push(Math.max(s.translationLease || 0, s.translationRetryAt || 0, now));
  for (const job of value.jobs) { if (job.status === 'queued') times.push(now); else if (job.status === 'running') times.push(job.lease || now); }
  value.nextWorkAt = times.reduce((earliest, time) => Math.min(earliest, time), Infinity);
}

export async function createRepository(options = {}) {
  const root = resolve(options.root || process.env.RECORD_DATA_DIR || '.data/records');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let db, pool;
  const objects = await createS3Objects(options.s3);
  const audioStaging = join(root, 'audio', '.pending');
  if (!objects) await mkdir(audioStaging, { recursive: true, mode: 0o700 });
  const databaseUrl = options.databaseUrl ?? process.env.RECORD_DATABASE_URL;
  if (databaseUrl) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: databaseUrl });
    await pool.query('CREATE TABLE IF NOT EXISTS record_aggregates (id text PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query("CREATE INDEX IF NOT EXISTS record_work_due ON record_aggregates (((data->>'nextWorkAt')::bigint)) WHERE data->>'kind'='record'");
  } else {
    const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(join(root, 'records.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS aggregates (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.exec("CREATE INDEX IF NOT EXISTS work_due ON aggregates(json_extract(data, '$.nextWorkAt'))");
    db.exec('CREATE TABLE IF NOT EXISTS aggregate_payloads(id TEXT PRIMARY KEY, payload BLOB NOT NULL)');
    if (options.compressAggregates) db.exec('PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216');
  }
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS record_list_projection(id text PRIMARY KEY,data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS record_feed_meta(id text PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS record_feed_events(record_id text NOT NULL, cursor text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(record_id,cursor))');
  } else db.exec('CREATE TABLE IF NOT EXISTS record_list_projection(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS record_feed_meta(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS record_feed_events(record_id TEXT NOT NULL,cursor TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(record_id,cursor))');
  function writeSqliteProjection(value, before) {
    const projection=deriveProjection(value,before); if(!projection)return;
    db.prepare('INSERT INTO record_list_projection(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(projection.list));
    db.prepare('INSERT INTO record_feed_meta(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(projection.meta));
    if(value.deleted)db.prepare('DELETE FROM record_feed_events WHERE record_id=?').run(value.id);
    for(const event of projection.events) db.prepare('INSERT INTO record_feed_events(record_id,cursor,data) VALUES(?,?,?) ON CONFLICT(record_id,cursor) DO UPDATE SET data=excluded.data').run(value.id,cursorKey(event.cursor),JSON.stringify(event));
    db.prepare('DELETE FROM record_feed_events WHERE record_id=? AND cursor<?').run(value.id,cursorKey(projection.meta.first));
  }
  async function writePgProjection(client,value,before) {
    const projection=deriveProjection(value,before); if(!projection)return;
    await client.query('INSERT INTO record_list_projection(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[value.id,JSON.stringify(projection.list)]);
    await client.query('INSERT INTO record_feed_meta(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[value.id,JSON.stringify(projection.meta)]);
    if(value.deleted)await client.query('DELETE FROM record_feed_events WHERE record_id=$1',[value.id]);
    for(const event of projection.events) await client.query('INSERT INTO record_feed_events(record_id,cursor,data) VALUES($1,$2,$3) ON CONFLICT(record_id,cursor) DO UPDATE SET data=excluded.data',[value.id,cursorKey(event.cursor),JSON.stringify(event)]);
    await client.query('DELETE FROM record_feed_events WHERE record_id=$1 AND cursor<$2',[value.id,cursorKey(projection.meta.first)]);
  }
  const decode = row => {
    const value = row ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : null;
    if (!pool && value?.$payload === 'deflate-v1') {
      const stored = db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(value.id);
      requireThat(stored, 'storage_corrupt', 500);
      return JSON.parse(decodeStorage(stored.payload).toString());
    }
    return value;
  };
  function writeSqliteValue(value, insert = false) {
    const json = JSON.stringify(value);
    const packed = options.compressAggregates && value.kind === 'record' ? encodeStorage(Buffer.from(json)) : { compressed: false };
    const metadata = packed.compressed ? JSON.stringify({ id: value.id, kind: value.kind, owner: value.owner, deleted: value.deleted, deleteAt: value.deleteAt, nextWorkAt: value.nextWorkAt, $payload: 'deflate-v1' }) : json;
    if (insert) db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)').run(value.id, metadata);
    else db.prepare('UPDATE aggregates SET data=? WHERE id=?').run(metadata, value.id);
    if (packed.compressed) db.prepare('INSERT INTO aggregate_payloads(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id, packed.bytes);
    else db.prepare('DELETE FROM aggregate_payloads WHERE id=?').run(value.id);
  }

  const workCursors = new Map(), legacyAnalysisInputs = new Map();
  const repository = {
    root, backend: pool ? 'postgres' : 'sqlite', audioBackend: objects ? 's3' : 'filesystem',
    async get(id) { return decode(pool ? (await pool.query('SELECT data FROM record_aggregates WHERE id=$1', [id])).rows[0]
      : db.prepare('SELECT data FROM aggregates WHERE id=?').get(id)); },
    async listSummaries(owner,scope='all',query='') {
      const rows=pool ? (await pool.query(`SELECT data->'summary' AS data FROM record_list_projection WHERE data->>'owner'=$1 AND data->>'deleted'='false' AND data->>'deleteAt'>$2 AND ($3='all' OR ($3='inbox' AND data->'summary'->>'workspaceId' IS NULL) OR data->'summary'->>'workspaceId'=$3) AND strpos(data->>'search',$4)>0 ORDER BY data->'summary'->>'createdAt' DESC, id DESC LIMIT 200`,[owner,new Date().toISOString(),scope,query])).rows : db.prepare(`SELECT json_extract(data,'$.summary') AS data FROM record_list_projection WHERE json_extract(data,'$.owner')=? AND json_extract(data,'$.deleted')=0 AND json_extract(data,'$.deleteAt')>? AND (?='all' OR (?='inbox' AND json_extract(data,'$.summary.workspaceId') IS NULL) OR json_extract(data,'$.summary.workspaceId')=?) AND instr(json_extract(data,'$.search'),?)>0 ORDER BY json_extract(data,'$.summary.createdAt') DESC, id DESC LIMIT 200`).all(owner,new Date().toISOString(),scope,scope,scope,query);
      return rows.map(decode);
    },
    async eventsAfter(id,cursor) {
      const meta=decode(pool ? (await pool.query('SELECT data FROM record_feed_meta WHERE id=$1',[id])).rows[0] : db.prepare('SELECT data FROM record_feed_meta WHERE id=?').get(id));
      if(!meta)return null;
      const rows=pool ? (await pool.query('SELECT data FROM record_feed_events WHERE record_id=$1 AND cursor>$2 ORDER BY cursor LIMIT 1000',[id,cursorKey(cursor)])).rows : db.prepare('SELECT data FROM record_feed_events WHERE record_id=? AND cursor>? ORDER BY cursor LIMIT 1000').all(id,cursorKey(cursor));
      return {...meta,events:rows.map(decode)};
    },
    async list(kind = 'record') {
      const rows = pool ? (await pool.query("SELECT data FROM record_aggregates WHERE data->>'kind'=$1", [kind])).rows
        : db.prepare("SELECT data FROM aggregates WHERE json_extract(data, '$.kind')=?").all(kind);
      return rows.map(decode);
    },
    async listAnalysisInputs() {
      const rows = pool ? (await pool.query('SELECT data FROM record_feed_meta')).rows : db.prepare('SELECT data FROM record_feed_meta').all();
      const inputs = [], present = new Set();
      for (const row of rows) {
        const meta = decode(row); present.add(meta.id);
        if (meta.deleted || Date.parse(meta.deleteAt) <= Date.now()) { legacyAnalysisInputs.delete(meta.id); continue; }
        if (meta.analysisInput) { legacyAnalysisInputs.delete(meta.id); inputs.push({...meta.analysisInput}); continue; }
        const key = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
        let cached = legacyAnalysisInputs.get(meta.id);
        if (cached?.key !== key) {
          const record = await repository.get(meta.id);
          if (!record) { legacyAnalysisInputs.delete(meta.id); continue; }
          cached = {key, input: analysisInput(record)}; legacyAnalysisInputs.set(meta.id, cached);
        }
        inputs.push({...cached.input});
      }
      for (const id of legacyAnalysisInputs.keys()) if (!present.has(id)) legacyAnalysisInputs.delete(id);
      return inputs;
    },
    async listWork({ lane = 'all' } = {}) {
      const after = workCursors.get(lane) || '', now = Date.now();
      const page = async (start, end, limit) => pool
        ? (await pool.query("SELECT data FROM record_aggregates WHERE data->>'kind'='record' AND (data->>'nextWorkAt' IS NULL OR (data->>'nextWorkAt')::bigint <= $1) AND id>$2 AND ($3::text IS NULL OR id<=$3) ORDER BY id LIMIT $4", [now, start, end, limit])).rows
        : db.prepare("SELECT data FROM aggregates WHERE json_extract(data,'$.kind')='record' AND (json_extract(data,'$.nextWorkAt') IS NULL OR json_extract(data,'$.nextWorkAt')<=?) AND id>? AND (? IS NULL OR id<=?) ORDER BY id LIMIT ?").all(now, start, end, end, limit);
      const rows = await page(after, null, 100);
      if (after && rows.length < 100) rows.push(...await page('', after, 100 - rows.length));
      if (rows.length) workCursors.set(lane, typeof rows.at(-1).data === 'string' ? JSON.parse(rows.at(-1).data).id : rows.at(-1).data.id);
      else workCursors.delete(lane);
      return rows.map(decode);
    },
    async insert(value) {
      schedule(value);
      traceWrite(value);
      const client=pool ? await pool.connect() : null;
      try {
        if(client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        if (client) await client.query('INSERT INTO record_aggregates(id,data) VALUES($1,$2)', [value.id, JSON.stringify(value)]);
        else writeSqliteValue(value, true);
        if(client){await writePgProjection(client,value);await client.query('COMMIT');}else{writeSqliteProjection(value);db.exec('COMMIT');}
      } catch (error) { if(client)await client.query('ROLLBACK');else db.exec('ROLLBACK'); if (error.code === '23505' || error.code?.startsWith('ERR_SQLITE')) throw new DomainError('already_exists'); throw error; } finally {client?.release();}
      return value;
    },
    async changeMany(ids, mutate) {
      const client = pool ? await pool.connect() : null;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        const values = [], snapshots = new Map();
        for (const id of [...new Set(ids)].sort()) {
          const value = decode(client ? (await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE', [id])).rows[0] : db.prepare('SELECT data FROM aggregates WHERE id=?').get(id));
          requireThat(value, 'not_found', 404); values.push(value); snapshots.set(value.id,visibleSnapshot(value));
        }
        const result = mutate(values);
        requireThat(!(result instanceof Promise), 'transaction_must_be_synchronous', 500);
        for (const value of values) {
          schedule(value);
          traceWrite(value);
          if (client) await client.query('UPDATE record_aggregates SET data=$2 WHERE id=$1', [value.id, JSON.stringify(value)]);
          else writeSqliteValue(value);
          if(client)await writePgProjection(client,value,snapshots.get(value.id));else writeSqliteProjection(value,snapshots.get(value.id));
        }
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
        return structuredClone(result ?? values);
      } catch (error) {
        if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK');
        throw error;
      } finally { client?.release(); }
    },
    async change(id, mutate, { rebuild = false } = {}) {
      const client = pool ? await pool.connect() : null;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        const value = decode(client ? (await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE', [id])).rows[0]
          : db.prepare('SELECT data FROM aggregates WHERE id=?').get(id));
        requireThat(value, 'not_found', 404);
        const original = JSON.stringify(value);
        const before=rebuild ? null : visibleSnapshot(value);
      const result = mutate(value);
        requireThat(!(result instanceof Promise), 'transaction_must_be_synchronous', 500);
        if (!rebuild && JSON.stringify(value) === original) { if (client) await client.query('COMMIT'); else db.exec('COMMIT'); return structuredClone(result ?? value); }
        schedule(value);
        traceWrite(value);
        if (client) await client.query('UPDATE record_aggregates SET data=$2 WHERE id=$1', [id, JSON.stringify(value)]);
        else writeSqliteValue(value);
        if(client)await writePgProjection(client,value,before);else writeSqliteProjection(value,before);
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
        return structuredClone(result ?? value);
      } catch (error) { if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK'); throw error; }
      finally { client?.release(); }
    },
    async putAudio(recordId, bytes) {
      bytes = Buffer.from(bytes);
      if (objects) return objects.put(recordId, bytes);
      requireThat(/^[a-f0-9-]{36}$/.test(recordId), 'invalid_record_id', 400);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const directory = join(root, 'audio', recordId); await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, hash);
      const temporary = join(audioStaging, `.tmp-${randomUUID()}`);
      try {
        const stored = options.compressAudio ? encodeStorage(bytes).bytes : bytes;
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(stored); await handle.sync(); } finally { await handle.close(); }
        try { await link(temporary, file); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let original;
          try { original = decodeStorage(await readFile(file), hash); } catch { throw new DomainError('audio_object_corrupt', 500); }
          requireThat(original.equals(bytes), 'audio_object_corrupt', 500);
        }
      } finally { await rm(temporary, { force: true }); }
      await flushAudioObject(file,directory);
      return { digest: hash, object: `${recordId}/${hash}` };
    },
    async readAudio(object) {
      if (objects) return objects.read(object);
      requireThat(/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(object), 'invalid_object', 400);
      return decodeStorage(await readFile(join(root, 'audio', object)), object.split('/')[1]);
    },
    async cleanAudio(recordId, liveObjects = new Set(), olderThan = Infinity) {
      if (objects) return objects.clean(recordId, liveObjects, olderThan);
      requireThat(/^[a-f0-9-]{36}$/.test(recordId), 'invalid_record_id', 400);
      const directory = join(root, 'audio', recordId);
      const entries = await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      for (const file of entries) if (/^[a-f0-9]{64}$/.test(file) && !liveObjects.has(`${recordId}/${file}`) && (await stat(join(directory, file))).mtimeMs < olderThan) await rm(join(directory, file));
    },
    async close() { objects?.close(); if (pool) await pool.end(); else db.close(); }
  };
  const missing=pool ? (await pool.query("SELECT a.id FROM record_aggregates a LEFT JOIN record_feed_meta m ON a.id=m.id LEFT JOIN record_list_projection l ON a.id=l.id WHERE a.data->>'kind'='record' AND (m.id IS NULL OR l.id IS NULL)")).rows : db.prepare("SELECT a.id FROM aggregates a LEFT JOIN record_feed_meta m ON a.id=m.id LEFT JOIN record_list_projection l ON a.id=l.id WHERE json_extract(a.data,'$.kind')='record' AND (m.id IS NULL OR l.id IS NULL)").all();
  for(const {id} of missing)await repository.change(id,()=>{}, {rebuild:true});
  for (const name of ['listAnalysisInputs','listSummaries','eventsAfter','get', 'list', 'listWork', 'change', 'changeMany', 'putAudio']) {
    const operation = repository[name];
    repository[name] = (...args) => telemetry.measure(`db.${name}`, { backend: repository.backend, ...(typeof args[0] === 'string' && name !== 'list' ? {recordId:args[0]} : {}) }, () => operation(...args));
  }
  return repository;
}

import { createRecordSearch } from './record-search.mjs';
import {createIndexedAudioStore} from './indexed-audio-store.mjs';
import {createPostgresRecordStore} from './postgres-record-store.mjs';
import { createKnowledgeStore } from './knowledge-store.mjs';
import { createRepositoryNotifications } from './repository-notifications.mjs';
import {createSqliteRecordStore,sameRecordSnapshot,backupLegacyRecordStore} from './sqlite-record-store.mjs';
import {audioBackupNeedsWork,audioBackupReady} from './audio-backup.mjs';
import { canStartSpeechSource } from './asr-recovery.mjs';
import { analysisInput, workspaceOverviewInput } from '../../../packages/records/src/workspaces.mjs';
import {flushAudioObject} from './audio-storage-sync.mjs';
import {learningWorkAt} from '../../../packages/records/src/learning.mjs';
import { cursorKey, deriveProjection, visibleSnapshot } from './projections.mjs';
import { automaticMinutesAt, updateMinutesPreview } from '../../../packages/records/src/automation.mjs';
import { mkdir, open, readFile, readdir, rm, stat, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, requireThat, audioPurgeReady, publicRecord, audioSummary } from '../../../packages/records/src/record.mjs';
import { createS3Objects } from './s3.mjs';
import { telemetry } from './telemetry.mjs';
import { encodeStorage, decodeStorage } from './storage-codec.mjs';

function traceWrite(value){if(telemetry.enabled)telemetry.event('db.write',{recordId:value.id,bytes:Buffer.byteLength(JSON.stringify(value))});}
const workerLanes=['audio','realtime','minutes','intents','translation','translation-live','translation-preview','learning'];
const workExpression=(lane,postgres)=>lane==='workspace'
  ? postgres ? "CASE WHEN data->>'status'='queued' THEN 0 WHEN data->>'status'='running' THEN COALESCE((data->>'lease')::bigint,0) END" : "CASE WHEN json_extract(data,'$.status')='queued' THEN 0 WHEN json_extract(data,'$.status')='running' THEN COALESCE(json_extract(data,'$.lease'),0) END"
  : postgres ? `CASE WHEN jsonb_typeof(data->'workAt') IS DISTINCT FROM 'object' THEN 0 ELSE (data->'workAt'->>'${lane}')::bigint END` : `CASE WHEN COALESCE(json_type(data,'$.workAt'),'')<>'object' THEN 0 ELSE json_extract(data,'$.workAt.${lane}') END`;

function schedule(value, now=Date.now()) {
  if(value.kind!=='record')return;
  const work=Object.fromEntries(workerLanes.map(lane=>[lane,Infinity]));
  const due=(lane,time)=>{work[lane]=Math.min(work[lane],time);};
  if(value.deleted){due('audio',value.cleanup==='completed'?(value.cleanupAt||0)+600000:now);}
  else{
    due('audio',Math.min(Date.parse(value.deleteAt),(value.gcAt||0)+3600000));
    if(audioBackupNeedsWork(value)&&audioBackupReady(value))due('audio',Math.max(value.audioBackup.retryAt||0,value.audioBackup.leaseUntil||0));
    due('learning',learningWorkAt(value,now));
    if(value.learning?.enabled&&value.capture==='completed'&&value.learning.revision!==value.transcriptRevision)due('learning',Math.max(now,value.learning.retryAt||0));
    due('minutes',automaticMinutesAt(value,now));
    if(audioPurgeReady(value))due('audio',now);
    if(value.realtimeAudioConsent&&value.autoMinutes?.enabled&&value.capture!=='completed'&&value.chunks.length)due('realtime',Math.max(value.realtime?.retryAt||0,now));
    for(const source of value.sources){
      if(source.asr?.state==='running' && source.asr.provider!=='sensevoice-local')due('audio',now+250);
      if(source.asr?.state==='failed'){
        let retryAt=Math.max(now,source.asr.retryAt||0,source.asr.lease||0);
        for(const chunk of value.chunks)if(chunk.sourceId===source.id&&chunk.state==='processing')retryAt=Math.max(retryAt,chunk.lease||0);
        if(canStartSpeechSource(value,source,retryAt))due('audio',retryAt);
      }
      const preview=source.asr?.preview,translation=source.asr?.translation;
      if(value.translationTarget&&source.asr?.state==='running'&&preview?.text?.trim().length>=4&&!(translation?.target===value.translationTarget&&translation.sourceText===preview.text&&translation.text)&& (translation?.requestedText!==preview.text||(translation?.attempts||0)<3))due('translation-preview',Math.max(now,translation?.lease||0,(translation?.requestedAt||0)+2500));
    }
    const watermarks=new Map(value.sources.map(source=>[source.id,source.watermark])),firstPending=new Map();
    for(const chunk of value.chunks)if(chunk.state!=='done')firstPending.set(chunk.sourceId,Math.min(firstPending.get(chunk.sourceId)??Infinity,chunk.sequence));
    for(const chunk of value.chunks){
      if(chunk.expired)continue;
      if(!value.retainAudio)due('audio',(chunk.acceptedAt||Date.parse(value.createdAt))+86400000);
      if(chunk.state!=='done'&&chunk.attempts<5&&watermarks.get(chunk.sourceId)>=chunk.sequence&&firstPending.get(chunk.sourceId)===chunk.sequence){
        const source=value.sources.find(source=>source.id===chunk.sourceId),freshDraft=chunk.batchWaiting&&source?.asr?.streaming&&source.watermark>(source.asr.streamedWatermark??-1);
        due('audio',Math.max(chunk.lease||0,freshDraft?0:chunk.retryAt||0,now));
      }
    }
    if(value.segments.length&&value.insights?.transcriptRevision!==value.transcriptRevision)due('intents',Math.max(value.intentLease||0,value.intentRetryAt||0,now));
    if(value.translationTarget){
      const liveFrom=value.translationLiveFromMs??value.segments.reduce((end,segment)=>Math.max(end,segment.endMs),0);
      for(const segment of value.segments){
        if(segment.translationLanguage===value.translationTarget||(segment.translationAttempts||0)>=3)continue;
        const time=Math.max(segment.translationLease||0,segment.translationRetryAt||0,now);due('translation',time);
        if(value.capture==='recording'&&segment.endMs>=liveFrom)due('translation-live',time);
      }
    }
    for(const job of value.jobs){if(job.status==='queued')due('minutes',now);else if(job.status==='running')due('minutes',job.lease||now);}
  }
  value.workAt=work;value.nextWorkAt=Math.min(...Object.values(work));
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
    await pool.query("CREATE INDEX IF NOT EXISTS record_kind_owner ON record_aggregates ((data->>'kind'),(data->>'owner'))");
    await pool.query("CREATE INDEX IF NOT EXISTS record_work_due ON record_aggregates (((data->>'nextWorkAt')::bigint)) WHERE data->>'kind'='record'");
  } else {
    const { DatabaseSync } = await import('node:sqlite'); db = new DatabaseSync(join(root, 'records.sqlite'));
    // A previous backend/worker may still be releasing its write lock on restart.
    // Install the wait policy before journal_mode, which also needs that lock.
    db.exec('PRAGMA busy_timeout=5000');
    try{await backupLegacyRecordStore(db,root);}catch(error){db.close();throw error;}
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS aggregates (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.exec("CREATE INDEX IF NOT EXISTS aggregate_kind_owner ON aggregates(json_extract(data, '$.kind'),json_extract(data, '$.owner'))");
    db.exec("CREATE INDEX IF NOT EXISTS work_due ON aggregates(json_extract(data, '$.nextWorkAt'))");
    db.exec('CREATE TABLE IF NOT EXISTS aggregate_payloads(id TEXT PRIMARY KEY, payload BLOB NOT NULL)');
    if (options.compressAggregates) db.exec('PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216');
  }
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS record_list_projection(id text PRIMARY KEY,data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS record_feed_meta(id text PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS record_feed_events(record_id text NOT NULL, cursor text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(record_id,cursor))');
  } else db.exec('CREATE TABLE IF NOT EXISTS record_list_projection(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS record_feed_meta(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS record_feed_events(record_id TEXT NOT NULL,cursor TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(record_id,cursor))');
  const recordSearch = await createRecordSearch({ db, pool });
  const shareSchema = 'CREATE TABLE IF NOT EXISTS record_share_index(hash TEXT PRIMARY KEY, record_id TEXT NOT NULL, expires BIGINT NOT NULL); CREATE INDEX IF NOT EXISTS record_share_record ON record_share_index(record_id); CREATE TABLE IF NOT EXISTS record_share_schema(version INTEGER PRIMARY KEY)';
  if (pool) for (const statement of shareSchema.split(';').map(s => s.trim()).filter(Boolean)) await pool.query(statement);
  else db.exec(shareSchema);
  const knowledge = await createKnowledgeStore({db,pool});
  const shareState = value => value.kind === 'record' ? JSON.stringify([value.deleted, value.deleteAt, value.shares]) : '';
  const activeShares = value => value.deleted ? [] : (value.shares || []).filter(share => !share.revoked).map(share => ({ ...share, expires: Math.min(share.expires, Date.parse(value.deleteAt)) }));
  function writeSqliteShares(value, previous) {
    if (value.kind !== 'record' || previous === shareState(value)) return;
    db.prepare('DELETE FROM record_share_index WHERE record_id=?').run(value.id);
    for (const share of activeShares(value)) db.prepare('INSERT INTO record_share_index(hash,record_id,expires) VALUES(?,?,?)').run(share.hash, value.id, share.expires);
  }
  async function writePgShares(client, value, previous) {
    if (value.kind !== 'record' || previous === shareState(value)) return;
    await client.query('DELETE FROM record_share_index WHERE record_id=$1', [value.id]);
    for (const share of activeShares(value)) await client.query('INSERT INTO record_share_index(hash,record_id,expires) VALUES($1,$2,$3)', [share.hash, value.id, share.expires]);
  }
  function writeSqliteProjection(value, before, previousShares) {
    knowledge.writeSqlite(value);
    if(value.kind==='record')audioStore.syncSqlite(value,audioSummary(value));
    writeSqliteShares(value, previousShares);
    const projection=deriveProjection(value,before);
    if(!projection){
      if(before?.kind==='record')for(const table of ['record_feed_meta','record_list_projection','record_feed_events'])db.prepare(`DELETE FROM ${table} WHERE ${table==='record_feed_events'?'record_id':'id'}=?`).run(value.id);
      return;
    }
    projection.meta.writeVersion=randomUUID();
    const previousSearch=db.prepare("SELECT rowid,json_extract(data,'$.search') AS search FROM record_list_projection WHERE id=?").get(value.id);
    db.prepare('INSERT INTO record_list_projection(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(projection.list));
    if(value.deleted)db.prepare('DELETE FROM record_search WHERE rowid=?').run(previousSearch?.rowid??-1);
    else if(!previousSearch||previousSearch.search!==projection.list.search)db.prepare('INSERT OR REPLACE INTO record_search(rowid,search) VALUES((SELECT rowid FROM record_list_projection WHERE id=?),?)').run(value.id,projection.list.search);
    db.prepare('INSERT INTO record_feed_meta(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,JSON.stringify(projection.meta));
    if(value.deleted)db.prepare('DELETE FROM record_feed_events WHERE record_id=?').run(value.id);
    for(const event of projection.events) db.prepare('INSERT INTO record_feed_events(record_id,cursor,data) VALUES(?,?,?) ON CONFLICT(record_id,cursor) DO UPDATE SET data=excluded.data').run(value.id,cursorKey(event.cursor),JSON.stringify(event));
    db.prepare('DELETE FROM record_feed_events WHERE record_id=? AND cursor<?').run(value.id,cursorKey(projection.meta.first));
  }
  async function writePgProjection(client,value,before,previousShares) {
    await knowledge.writePg(client,value);
    if(value.kind==='record')await audioStore.syncPg(client,value,audioSummary(value));
    await writePgShares(client,value,previousShares);
    const projection=deriveProjection(value,before);
    if(!projection){
      if(before?.kind==='record')for(const table of ['record_feed_meta','record_list_projection','record_feed_events'])await client.query(`DELETE FROM ${table} WHERE ${table==='record_feed_events'?'record_id':'id'}=$1`,[value.id]);
      return;
    }
    projection.meta.writeVersion=randomUUID();
    await client.query('INSERT INTO record_list_projection(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[value.id,JSON.stringify(projection.list)]);
    await recordSearch.updatePg(client, value.id, projection.list.search);
    await client.query('INSERT INTO record_feed_meta(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data',[value.id,JSON.stringify(projection.meta)]);
    if(value.deleted)await client.query('DELETE FROM record_feed_events WHERE record_id=$1',[value.id]);
    for(const event of projection.events) await client.query('INSERT INTO record_feed_events(record_id,cursor,data) VALUES($1,$2,$3) ON CONFLICT(record_id,cursor) DO UPDATE SET data=excluded.data',[value.id,cursorKey(event.cursor),JSON.stringify(event)]);
    await client.query('DELETE FROM record_feed_events WHERE record_id=$1 AND cursor<$2',[value.id,cursorKey(projection.meta.first)]);
  }
  const sqliteStore=db?createSqliteRecordStore(db,options):null;
  const postgresStore=pool?await createPostgresRecordStore(pool):null;
  const audioStore=await createIndexedAudioStore({db,pool,sqliteStore,putAudio:(...args)=>repository.putAudio(...args),committed:(...args)=>notifications.committed(...args)});
  const decode = row => {
    const value=row?(typeof row.data==='string'?JSON.parse(row.data):row.data):null;
    return sqliteStore?sqliteStore.decode(value):value;
  };
  const writeSqliteValue=(value,insert=false,prepared)=>sqliteStore.write(value,insert,prepared);
  const workCursors = new Map(), legacyAnalysisInputs = new Map();
  for(const lane of [...workerLanes,'workspace']){
    const name='record_due_'+lane.replaceAll('-','_'),kind=lane==='workspace'?'workspace-analysis':'record';
    if(pool)await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON record_aggregates((${workExpression(lane,true)})) WHERE data->>'kind'='${kind}'`);
    else db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON aggregates((${workExpression(lane,false)})) WHERE json_extract(data,'$.kind')='${kind}'`);
  }
  const notifications=await createRepositoryNotifications({root,db,pool}).catch(async error=>{if(pool)await pool.end();else db.close();throw error;});
  const repository = {
    ingestAudio: audioStore.ingest,
    async changeMinutesPreview(id, jobId, fence, text, runtime) {
      const outcome = await audioStore.changeMinutesPreview(id, jobId, fence, text, runtime);
      if (outcome.unsupported) return repository.change(id, record => updateMinutesPreview(record, jobId, fence, text, runtime), { returnRecord:false });
    },
    async changeTranslation(id, selector, operation) {
      const outcome = await audioStore.changeTranslation(id, selector, operation);
      if (outcome.unsupported) return repository.change(id, operation, { returnRecord:false });
    },
    changeLocalAsr: audioStore.changeLocalAsr,
    inspectLocalAsr: audioStore.inspectLocalAsr,
    localAsrNeedsCleanup: audioStore.localAsrNeedsCleanup,
    localAsrTail: audioStore.localAsrTail,
    listKnowledge: knowledge.list,
    retrieveKnowledge: knowledge.retrieveKnowledge,
    validateKnowledge: knowledge.validateKnowledge,
    reviewKnowledge: knowledge.review,
    subscribeChanges(listener,options){return notifications.subscribe(listener,options);},
    async nextWorkAt(lane){
      requireThat(workerLanes.includes(lane)||lane==='workspace','invalid_worker_lane',400);
      const kind=lane==='workspace'?'workspace-analysis':'record';
      const row=pool?(await pool.query(`SELECT min(${workExpression(lane,true)}) AS due FROM record_aggregates WHERE data->>'kind'='${kind}'`)).rows[0]:db.prepare(`SELECT min(${workExpression(lane,false)}) AS due FROM aggregates WHERE json_extract(data,'$.kind')='${kind}'`).get();
      return row?.due==null?Infinity:Number(row.due);
    },
    async accessRevision() {
      if (pool) return (await pool.query('SELECT pg_current_snapshot()::text AS revision')).rows[0].revision;
      return `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() AS changes').get().changes}`;
    },
    async recordingActive() {
      if (pool) return Boolean((await pool.query("SELECT 1 FROM record_list_projection WHERE COALESCE((data->>'deleted')::boolean,false)=false AND data->'summary'->>'capture'='recording' AND (data->>'deleteAt')::timestamptz>now() LIMIT 1")).rows.length);
      return Boolean(db.prepare("SELECT 1 FROM record_list_projection WHERE COALESCE(json_extract(data,'$.deleted'),0)=0 AND json_extract(data,'$.summary.capture')='recording' AND json_extract(data,'$.deleteAt')>? LIMIT 1").get(new Date().toISOString()));
    },
    root, backend: pool ? 'postgres' : 'sqlite', audioBackend: objects ? 's3' : 'filesystem',
    async listMetadata(kind, owner, fields, {recordId, status, automatic, limit=200, before}={}) {
      requireThat(typeof kind==='string'&&typeof owner==='string'&&Array.isArray(fields)&&fields.length<=40&&fields.every(key=>/^[A-Za-z][A-Za-z0-9]*$/.test(key))&&Number.isSafeInteger(limit)&&limit>0&&limit<=1000,'invalid_metadata_query',500);
      requireThat(automatic===undefined||typeof automatic==='boolean','invalid_metadata_query',500);
      requireThat(!before||(Array.isArray(before)&&before.length===2&&(typeof before[0]==='string'&&before[0].length<=200||Number.isSafeInteger(before[0]))&&typeof before[1]==='string'&&before[1].length<=200),'invalid_metadata_query',500);
      const keys=[...new Set(['id','kind','owner',...fields])];
      if(pool){
        const values=[kind,owner],where=["data->>'kind'=$1","data->>'owner'=$2"];
        if(recordId){values.push(recordId);where.push(`data->>'recordId'=$${values.length}`);}
        if(status){values.push(status);where.push(`data->>'status'=$${values.length}`);}
        if(automatic!==undefined){values.push(String(automatic));where.push(`data->>'automatic'=$${values.length}`);}
        if(before){values.push(String(before[0]),before[1]);where.push(`(data->>'createdAt',id)<($${values.length-1},$${values.length})`);}
        values.push(limit);
        const json=keys.flatMap(key=>[`'${key}'`,`data->'${key}'`]).join(',');
        return (await pool.query(`SELECT jsonb_build_object(${json}) AS data FROM record_aggregates WHERE ${where.join(' AND ')} ORDER BY data->>'createdAt' DESC,id DESC LIMIT $${values.length}`,values)).rows.map(row=>row.data);
      }
      const values=[kind,owner],where=["json_extract(data,'$.kind')=?","json_extract(data,'$.owner')=?"];
      if(recordId){values.push(recordId);where.push("json_extract(data,'$.recordId')=?");}
      if(status){values.push(status);where.push("json_extract(data,'$.status')=?");}
      if(automatic!==undefined){values.push(Number(automatic));where.push("json_extract(data,'$.automatic')=?");}
      if(before){values.push(before[0],before[1]);where.push("(json_extract(data,'$.createdAt'),id)<(?,?)");}
      values.push(limit);
      const json=keys.flatMap(key=>[`'${key}'`,`json_extract(data,'$.${key}')`]).join(',');
      return db.prepare(`SELECT json_object(${json}) AS data FROM aggregates WHERE ${where.join(' AND ')} ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ?`).all(...values).map(row=>JSON.parse(row.data));
    },
    async get(id) { return postgresStore?postgresStore.read(id):decode(db.prepare('SELECT data FROM aggregates WHERE id=?').get(id)); },
    // Access checks never decode/inflate transcript or minutes bodies. The projection
    // token changes in the same transaction on every write, even without an event.
    async getRecordAccess(ids) {
      const unique=[...new Set(ids)], rows=[];
      for(let offset=0;offset<unique.length;offset+=500){
        const batch=unique.slice(offset,offset+500);
        rows.push(...(pool ? (await pool.query(`SELECT id, COALESCE(data->'analysisInput'->>'kind','record') AS kind, data->>'owner' AS owner, (data->>'deleted')::boolean AS deleted, data->>'deleteAt' AS "deleteAt", data->>'capture' AS capture, COALESCE(data->>'writeVersion',data->>'cursor') AS version FROM record_feed_meta WHERE id=ANY($1::text[])`,[batch])).rows
          : db.prepare(`SELECT id, COALESCE(json_extract(data,'$.analysisInput.kind'),'record') AS kind, json_extract(data,'$.owner') AS owner, json_extract(data,'$.deleted') AS deleted, json_extract(data,'$.deleteAt') AS deleteAt, json_extract(data,'$.capture') AS capture, COALESCE(json_extract(data,'$.writeVersion'),json_extract(data,'$.cursor')) AS version FROM record_feed_meta WHERE id IN (${batch.map(()=>'?').join(',')})`).all(...batch)));
      }
      return rows.map(row=>({...row,deleted:!!row.deleted}));
    },
    async findShare(hash) {
      const row = pool ? (await pool.query('SELECT record_id FROM record_share_index WHERE hash=$1 AND expires>$2', [hash, Date.now()])).rows[0] : db.prepare('SELECT record_id FROM record_share_index WHERE hash=? AND expires>?').get(hash, Date.now());
      return row ? repository.get(row.record_id) : null;
    },
    async listRecordHeaders(owner){
      const rows=pool?(await pool.query("SELECT data FROM record_feed_meta WHERE data->>'owner'=$1",[owner])).rows:db.prepare("SELECT data FROM record_feed_meta WHERE json_extract(data,'$.owner')=?").all(owner);
      return rows.map(decode);
    },
    async listOverviewInputs(owner){
      const rows=pool?(await pool.query("SELECT id,data->'overview' AS data,(SELECT duration_ms FROM record_audio_stats WHERE record_id=record_list_projection.id) AS duration_ms,(SELECT samples FROM record_audio_stats WHERE record_id=record_list_projection.id) AS samples FROM record_list_projection WHERE data->>'owner'=$1 AND data->>'deleted'='false' AND data->>'deleteAt'>$2",[owner,new Date().toISOString()])).rows:db.prepare("SELECT id,json_extract(data,'$.overview') AS data,(SELECT duration_ms FROM record_audio_stats WHERE record_id=record_list_projection.id) AS duration_ms,(SELECT samples FROM record_audio_stats WHERE record_id=record_list_projection.id) AS samples FROM record_list_projection WHERE json_extract(data,'$.owner')=? AND json_extract(data,'$.deleted')=0 AND json_extract(data,'$.deleteAt')>?").all(owner,new Date().toISOString());
      const result=[];
      for(const row of rows){
        if(row.data){const input=typeof row.data==='string'?JSON.parse(row.data):row.data;if(Object.hasOwn(input.usage||{},'minutesMeter')){if(row.duration_ms!=null){input.overviewSeconds=Math.round(Number(row.duration_ms)/1000);input.usage={...input.usage,samples:Number(row.samples)};}result.push(input);continue;}}
        const record=await repository.get(row.id);if(record){result.push(workspaceOverviewInput(record));await repository.change(row.id,()=>{},{rebuild:true,returnRecord:false});}
      }
      return result;
    },
    listSummaries: recordSearch.list,

    async eventsAfter(id,cursor) {
      const meta=decode(pool ? (await pool.query('SELECT data FROM record_feed_meta WHERE id=$1',[id])).rows[0] : db.prepare('SELECT data FROM record_feed_meta WHERE id=?').get(id));
      if(!meta)return null;
      const rows=pool ? (await pool.query('SELECT data FROM record_feed_events WHERE record_id=$1 AND cursor>$2 ORDER BY cursor LIMIT 1000',[id,cursorKey(cursor)])).rows : db.prepare('SELECT data FROM record_feed_events WHERE record_id=? AND cursor>? ORDER BY cursor LIMIT 1000').all(id,cursorKey(cursor));
      return {...meta,events:rows.map(decode)};
    },
    async list(kind = 'record') {
      if(postgresStore)return postgresStore.list(kind);
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
    async listWork({ lane = 'all', metadataOnly = false } = {}) {
      const after = workCursors.get(lane) || '', now = Date.now();
      const selectedLane=workerLanes.includes(lane)?lane:null;
      const lanePg=selectedLane?`(${workExpression(selectedLane,true)})<=$1` : "(data->>'nextWorkAt' IS NULL OR (data->>'nextWorkAt')::bigint <= $1)";
      const laneSql=selectedLane?`(${workExpression(selectedLane,false)})<=?` : "(json_extract(data,'$.nextWorkAt') IS NULL OR json_extract(data,'$.nextWorkAt')<=?)";
      // Isolate selective due IDs so ID-order pagination cannot hide the due index.
      const filterPg=selectedLane?"id IN (SELECT id FROM record_aggregates WHERE data->>'kind'='record' AND "+lanePg+")":"data->>'kind'='record' AND "+lanePg;
      const filterSql=selectedLane?"id IN (SELECT id FROM aggregates WHERE json_extract(data,'$.kind')='record' AND "+laneSql+")":"json_extract(data,'$.kind')='record' AND "+laneSql;
      const page = async (start, end, limit) => pool
        ? (await pool.query("SELECT data FROM record_aggregates WHERE "+filterPg+" AND id>$2 AND ($3::text IS NULL OR id<=$3) ORDER BY id LIMIT $4", [now,start,end,limit])).rows
        : db.prepare("SELECT data FROM aggregates WHERE "+filterSql+" AND id>? AND (? IS NULL OR id<=?) ORDER BY id LIMIT ?").all(now,start,end,end,limit);
      const rows = await page(after, null, 100);
      if (after && rows.length < 100) rows.push(...await page('', after, 100 - rows.length));
      if (rows.length) workCursors.set(lane, typeof rows.at(-1).data === 'string' ? JSON.parse(rows.at(-1).data).id : rows.at(-1).data.id);
      else workCursors.delete(lane);
    const values=[];
      for(const row of rows){
        const metadata=typeof row.data==='string'?JSON.parse(row.data):row.data;
        if (metadataOnly && metadata.workAt) {
          values.push({ ...(pool ? metadata : sqliteStore.header(metadata)), $metadataOnly:true });
          continue;
        }
        const originalMetadata=pool?JSON.stringify(metadata):row.data;
        const value=postgresStore?await repository.get(row.id || row.data.id):decode(row);if(!value)continue;schedule(value,now);
        const dueAt=selectedLane?value.workAt[selectedLane]:value.nextWorkAt;
        const stale=!Number.isFinite(dueAt)||dueAt>now;
        if(!metadata.workAt||stale){
          const work=JSON.stringify(value.workAt),next=JSON.stringify(value.nextWorkAt);
          // Repair only the scheduling header. Compare the original row so concurrent work wins.
          if(pool)await pool.query("UPDATE record_aggregates SET data=jsonb_set(jsonb_set(data,'{workAt}',$2::jsonb),'{nextWorkAt}',$3::jsonb) WHERE id=$1 AND data=$4::jsonb",[value.id,work,next,originalMetadata]);
          else db.prepare("UPDATE aggregates SET data=json_set(data,'$.workAt',json(?),'$.nextWorkAt',json(?)) WHERE id=? AND data=?").run(work,next,value.id,row.data);
        }
        if(stale)continue;
        values.push(metadataOnly ? { ...(pool ? value : sqliteStore.header(metadata)), workAt:value.workAt, nextWorkAt:value.nextWorkAt, $metadataOnly:true } : value);
      }
      return values;
    },
    async saveExtensions(values,expected) {
      requireThat(Array.isArray(values)&&values.length>0&&values.length<=50&&values.every(v=>v.kind==='extension'&&v.owner===values[0].owner),'invalid_extension',400);
      const client=pool?await pool.connect():null;
      try{if(client)await client.query('BEGIN');else db.exec('BEGIN IMMEDIATE');
        for(const value of values){
          const raw=client?(await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE',[value.id])).rows[0]:db.prepare('SELECT data FROM aggregates WHERE id=?').get(value.id),current=raw?(typeof raw.data==='string'?JSON.parse(raw.data):raw.data):null;
          requireThat(expected?.[value.id]===JSON.stringify(current),'extension_version_changed',409);
          if(client)await client.query(current?'UPDATE record_aggregates SET data=$2 WHERE id=$1':'INSERT INTO record_aggregates(id,data) VALUES($1,$2)',[value.id,JSON.stringify(value)]);
          else if(current)db.prepare('UPDATE aggregates SET data=? WHERE id=?').run(JSON.stringify(value),value.id);else db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)').run(value.id,JSON.stringify(value));
        }
        if(client)await client.query('COMMIT');else db.exec('COMMIT');
      }catch(error){if(client)await client.query('ROLLBACK');else db.exec('ROLLBACK');throw error;}finally{client?.release();}
    },
    async insert(value) {
      schedule(value);
      traceWrite(value);
      const client=pool ? await pool.connect() : null;
      try {
        if(client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        if (client) await postgresStore.write(client,value,true);
        else writeSqliteValue(value, true);
        if(client){await writePgProjection(client,value);await client.query('COMMIT');}else{writeSqliteProjection(value);db.exec('COMMIT');}
      } catch (error) { if(client)await client.query('ROLLBACK');else db.exec('ROLLBACK'); if (error.code === '23505' || error.code === 'ERR_SQLITE_ERROR' && [1555,2067].includes(error.errcode)) throw new DomainError('already_exists'); throw error; } finally {client?.release();}
      notifications.committed([value],value);
      return value;
    },
    async changeMany(ids, mutate) {
      const client = pool ? await pool.connect() : null;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        const values = [], snapshots = new Map(), shareStates = new Map();
        for (const id of [...new Set(ids)].sort()) {
          const value = client ? await postgresStore.decode((await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE',[id])).rows[0]?.data,client) : decode(db.prepare('SELECT data FROM aggregates WHERE id=?').get(id));
          requireThat(value, 'not_found', 404); values.push(value); snapshots.set(value.id,visibleSnapshot(value)); shareStates.set(value.id,shareState(value));
        }
        const result = mutate(values);
        requireThat(!(result instanceof Promise), 'transaction_must_be_synchronous', 500);
        for (const value of values) {
          schedule(value);
          traceWrite(value);
          if (client) await postgresStore.write(client,value);
          else writeSqliteValue(value);
          if(client)await writePgProjection(client,value,snapshots.get(value.id),shareStates.get(value.id));else writeSqliteProjection(value,snapshots.get(value.id),shareStates.get(value.id));
        }
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
        notifications.committed(values,result??values);
      return structuredClone(result ?? values);
      } catch (error) {
        if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK');
        throw error;
      } finally { client?.release(); }
    },
    async change(id, mutate, { rebuild = false, returnRecord = true } = {}) {
      const client = pool ? await pool.connect() : null;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        const value = client ? await postgresStore.decode((await client.query('SELECT data FROM record_aggregates WHERE id=$1 FOR UPDATE',[id])).rows[0]?.data,client) : decode(db.prepare('SELECT data FROM aggregates WHERE id=?').get(id));
        requireThat(value, 'not_found', 404);
        const separated=sqliteStore&&value.kind==='record';
        const original=separated?sqliteStore.snapshot(value):JSON.stringify(value);
        const beforeJson=!rebuild&&value.kind==='record'?JSON.stringify(publicRecord(value)):null;
        const previousShares = rebuild ? undefined : shareState(value);
      const result = mutate(value);
        requireThat(!(result instanceof Promise), 'transaction_must_be_synchronous', 500);
        const prepared=separated?sqliteStore.prepare(value):null;
        if (!rebuild && (separated?sameRecordSnapshot(original,prepared):JSON.stringify(value)===original)) { if (client) await client.query('COMMIT'); else db.exec('COMMIT'); return !returnRecord && result==null ? undefined : structuredClone(result ?? value); }

        const before=beforeJson?JSON.parse(beforeJson):null;
        schedule(value);
        traceWrite(value);
        if (client) await postgresStore.write(client,value);
        else writeSqliteValue(value,false,prepared);
        if(client)await writePgProjection(client,value,before,previousShares);else writeSqliteProjection(value,before,previousShares);
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
        notifications.committed([value],!returnRecord&&result==null?undefined:result??value);
        return !returnRecord && result==null ? undefined : structuredClone(result ?? value);
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
    async close() { notifications.close(); objects?.close(); if (pool) await pool.end(); else db.close(); }
  };
  const shareVersion = pool ? (await pool.query('SELECT version FROM record_share_schema WHERE version=1')).rows[0] : db.prepare('SELECT version FROM record_share_schema WHERE version=1').get();
  if (!shareVersion) {
    let after = '';
    for (;;) {
      const client = pool ? await pool.connect() : null;
      let rows;
      try {
        if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
        rows = client ? (await client.query("SELECT data FROM record_aggregates WHERE data->>'kind'='record' AND id>$1 ORDER BY id LIMIT 100 FOR UPDATE", [after])).rows
          : db.prepare("SELECT data FROM aggregates WHERE json_extract(data,'$.kind')='record' AND id>? ORDER BY id LIMIT 100").all(after);
        for (const row of rows) { const value = client?await postgresStore.decode(row.data,client):decode(row); if (client) await writePgShares(client,value); else writeSqliteShares(value); after = value.id; }
        if (client) await client.query('COMMIT'); else db.exec('COMMIT');
      } catch (error) { if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK'); throw error; }
      finally { client?.release(); }
      if (rows.length < 100) break;
    }
    if (pool) await pool.query('INSERT INTO record_share_schema(version) VALUES(1) ON CONFLICT DO NOTHING');
    else db.prepare('INSERT OR IGNORE INTO record_share_schema(version) VALUES(1)').run();
  }
  const missing=pool ? (await pool.query("SELECT a.id FROM record_aggregates a LEFT JOIN record_feed_meta m ON a.id=m.id LEFT JOIN record_list_projection l ON a.id=l.id LEFT JOIN record_knowledge_state k ON a.id=k.record_id LEFT JOIN record_audio_stats t ON a.id=t.record_id WHERE a.data->>'kind'='record' AND (m.id IS NULL OR l.id IS NULL OR COALESCE((l.data->>'searchVersion')::int,0)<>3 OR k.record_id IS NULL OR a.data->>'$collections' IS DISTINCT FROM '2' OR a.data->>'$audioVersion' IS DISTINCT FROM '2' OR t.record_id IS NULL OR t.updated_at='')")).rows : db.prepare("SELECT a.id FROM aggregates a LEFT JOIN record_feed_meta m ON a.id=m.id LEFT JOIN record_list_projection l ON a.id=l.id LEFT JOIN record_knowledge_state k ON a.id=k.record_id LEFT JOIN record_audio_stats t ON a.id=t.record_id WHERE json_extract(a.data,'$.kind')='record' AND (m.id IS NULL OR l.id IS NULL OR COALESCE(json_extract(l.data,'$.searchVersion'),0)<>3 OR k.record_id IS NULL OR COALESCE(json_extract(a.data,'$.$collections'),0)<>2 OR COALESCE(json_extract(a.data,'$.$audioVersion'),0)<>2 OR t.record_id IS NULL OR t.updated_at='')").all();
  for(const {id} of missing)await repository.change(id,()=>{}, {rebuild:true});
  if(db)db.prepare('INSERT OR IGNORE INTO record_storage_schema(version) VALUES(2)').run();
  for (const name of ['saveExtensions','listAnalysisInputs','listSummaries','eventsAfter','get', 'list', 'listWork', 'change', 'changeMany', 'putAudio']) {
    const operation = repository[name];
    repository[name] = (...args) => telemetry.measure(`db.${name}`, { backend: repository.backend, ...(typeof args[0] === 'string' && name !== 'list' ? {recordId:args[0]} : {}) }, () => operation(...args));
  }
    return repository;
}

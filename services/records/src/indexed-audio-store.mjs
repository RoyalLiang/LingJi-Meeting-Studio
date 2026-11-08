import { createLocalAsrStore } from './local-asr-store.mjs';
import {randomUUID} from 'node:crypto';
import {acknowledge,digest,requireThat,publicSources,publicTranscription} from '../../../packages/records/src/record.mjs';
import {audioChunkIndex} from '../../../packages/records/src/audio-index.mjs';
import {chunkWaveform} from './waveform.mjs';
import {cursorKey} from './projections.mjs';

export async function createIndexedAudioStore({db,pool,sqliteStore,putAudio,committed}) {
  const schema=`CREATE TABLE IF NOT EXISTS record_audio_ranges(record_id TEXT NOT NULL,source_id TEXT NOT NULL,epoch TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,PRIMARY KEY(record_id,source_id,epoch,start_seq));
    CREATE UNIQUE INDEX IF NOT EXISTS audio_range_end ON record_audio_ranges(record_id,source_id,epoch,end_seq);
    CREATE TABLE IF NOT EXISTS record_audio_stats(record_id TEXT PRIMARY KEY,chunks INTEGER NOT NULL,duration_ms DOUBLE PRECISION NOT NULL,samples BIGINT NOT NULL,pending INTEGER NOT NULL,updated_at TEXT NOT NULL DEFAULT '',transcription TEXT NOT NULL DEFAULT 'idle');`;
  if(pool){
    for(const statement of schema.split(';').filter(statement=>statement.trim()))await pool.query(statement);
    await pool.query("ALTER TABLE record_audio_stats ADD COLUMN IF NOT EXISTS updated_at TEXT NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE record_audio_stats ADD COLUMN IF NOT EXISTS transcription TEXT NOT NULL DEFAULT 'idle'");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS audio_chunk_identity ON record_collections(record_id,(data->>'sourceId'),(data->>'epoch'),((data->>'sequence')::bigint)) WHERE field='chunks'");
  }else{
    db.exec(schema);
    if(!db.prepare('PRAGMA table_info(record_audio_stats)').all().some(row=>row.name==='updated_at'))db.exec("ALTER TABLE record_audio_stats ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    if(!db.prepare('PRAGMA table_info(record_audio_stats)').all().some(row=>row.name==='transcription'))db.exec("ALTER TABLE record_audio_stats ADD COLUMN transcription TEXT NOT NULL DEFAULT 'idle'");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS audio_chunk_identity ON record_collections(record_id,json_extract(data,'$.sourceId'),json_extract(data,'$.epoch'),json_extract(data,'$.sequence')) WHERE field='chunks'");
  }
  const sqlAction=(sql,params=[],select=false)=>({sql,params,select});
  const select=(sql,params=[])=>sqlAction(sql,params,true),write=(sql,params=[])=>sqlAction(sql,params);
  function sqliteAction(action){
    const parameters=[],sql=action.sql.replace(/\$(\d+)/g,(_match,index)=>{parameters.push(action.params[Number(index)-1]);return '?';});
    const statement=db.prepare(sql);return action.select?statement.all(...parameters):statement.run(...parameters);
  }
  function synchronous(operation){
    let next=operation.next();while(!next.done){try{next=operation.next(sqliteAction(next.value));}catch(error){next=operation.throw(error);}}return next.value;
  }
  async function asynchronous(client,operation){
    let next=operation.next();while(!next.done){try{const result=await client.query(next.value.sql,next.value.params);next=operation.next(next.value.select?result.rows:result);}catch(error){next=operation.throw(error);}}return next.value;
  }
  function sqliteTransaction(operation){
    db.exec('BEGIN IMMEDIATE');try{const result=synchronous(operation);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  async function pgTransaction(operation){
    const client=await pool.connect();try{await client.query('BEGIN');const result=await asynchronous(client,operation);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const transaction=operation=>pool?pgTransaction(operation):sqliteTransaction(operation);
  const raw=row=>pool?row.data:JSON.parse(row.data);
  const storedHeader=row=>pool?row?.data:sqliteStore.header(row?JSON.parse(row.data):null);
  function* getHeader(id,lock=false){return storedHeader((yield select(`SELECT data FROM ${pool?'record_aggregates':'aggregates'} WHERE id=$1${pool&&lock?' FOR UPDATE':''}`,[id]))[0]);}
  const owned=(header,owner)=>{
    requireThat(header?.kind==='record'&&header.owner===owner,'not_found',404);
    requireThat(!header.deleted&&Date.parse(header.deleteAt)>Date.now(),'record_deleted',410);
    requireThat(header.$collections===2&&header.$audioVersion===2&&header.$audio,'storage_not_ready',503);
    return header;
  };
  function* stats(record,summary){
    yield write('INSERT INTO record_audio_stats(record_id,chunks,duration_ms,samples,pending,updated_at,transcription) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(record_id) DO UPDATE SET chunks=excluded.chunks,duration_ms=excluded.duration_ms,samples=excluded.samples,pending=excluded.pending,updated_at=excluded.updated_at,transcription=excluded.transcription',[record.id,record.$counts?.chunks??record.chunks.length,summary.durationMs,record.usage.samples,summary.pendingChunks,record.updatedAt,publicTranscription(record)]);
  }
  async function sync(client,record,summary){
    const rows=async(sql,params)=>(await client.query(sql,params)).rows;
    const run=(sql,params)=>client.query(sql,params);
    if(record.kind!=='record')return;
    const previous=(await rows('SELECT chunks FROM record_audio_stats WHERE record_id=$1',[record.id]))[0];
    // Chunk identity is immutable; ASR state-only writes retain these intervals.
    if(!previous||Number(previous.chunks)!==record.chunks.length){
      await run('DELETE FROM record_audio_ranges WHERE record_id=$1',[record.id]);
      const index=audioChunkIndex(record);
      for(const source of record.sources)for(const [start,end] of index.ranges(source))await run('INSERT INTO record_audio_ranges(record_id,source_id,epoch,start_seq,end_seq) VALUES($1,$2,$3,$4,$5)',[record.id,source.id,source.epoch||'',start,end]);
    }
    await asynchronous(client,stats(record,summary));
  }
  function* inspect(header,chunk){
    const source=header.sources.find(source=>source.id===chunk.sourceId&&source.epoch===chunk.epoch);
    requireThat(source,'unknown_source',400);
    const sourceExpr=pool?"data->>'sourceId'":"json_extract(data,'$.sourceId')",epochExpr=pool?"data->>'epoch'":"json_extract(data,'$.epoch')",sequenceExpr=pool?"(data->>'sequence')::bigint":"json_extract(data,'$.sequence')";
    const nearby=yield select(`SELECT data FROM record_collections WHERE record_id=$1 AND field='chunks' AND ${sourceExpr}=$2 AND ${epochExpr}=$3 AND ${sequenceExpr} BETWEEN $4 AND $5`,[header.id,source.id,source.epoch,chunk.sequence-1,chunk.sequence+1]);
    const chunks=new Map(nearby.map(row=>{const item=raw(row);return[item.sequence,item];}));
    const ranges=(yield select('SELECT start_seq,end_seq FROM record_audio_ranges WHERE record_id=$1 AND source_id=$2 AND epoch=$3 ORDER BY start_seq',[header.id,source.id,source.epoch])).map(row=>[row.start_seq,row.end_seq]);
    let accepted,left,right;
    const index={count:header.$counts.chunks,get:(_source,sequence)=>chunks.get(sequence),ranges:()=>ranges,
      append(value){
        accepted=value;index.count++;chunks.set(value.sequence,value);
        const sequence=value.sequence;let low=0,high=ranges.length;
        while(low<high){const mid=(low+high)>>>1;if(ranges[mid][0]<sequence)low=mid+1;else high=mid;}
        left=ranges[low-1]?.[1]===sequence-1?[...ranges[low-1]]:undefined;
        right=ranges[low]?.[0]===sequence+1?[...ranges[low]]:undefined;
        ranges.splice(low-(left?1:0),(left?1:0)+(right?1:0),[left?.[0]??sequence,right?.[1]??sequence]);
      }};
    header.chunks=[];header.events=[];
    const result=acknowledge(header,chunk,index);
    return {result,accepted,left,right,ranges,source};
  }
  const localAsr = await createLocalAsrStore({db,pool,sqliteStore,transaction,select,write,getHeader,stats,committed});
  return {
    ...localAsr,
    syncSqlite(record,summary){
      // Synchronous SQLite writes belong to the caller's existing transaction.
      if(record.kind!=='record')return;
      const previous=db.prepare('SELECT chunks FROM record_audio_stats WHERE record_id=?').get(record.id);
      if(!previous||previous.chunks!==record.chunks.length){
        db.prepare('DELETE FROM record_audio_ranges WHERE record_id=?').run(record.id);
        const index=audioChunkIndex(record),put=db.prepare('INSERT INTO record_audio_ranges VALUES(?,?,?,?,?)');
        for(const source of record.sources)for(const [start,end]of index.ranges(source))put.run(record.id,source.id,source.epoch||'',start,end);
      }
      db.prepare('INSERT INTO record_audio_stats VALUES(?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET chunks=excluded.chunks,duration_ms=excluded.duration_ms,samples=excluded.samples,pending=excluded.pending,updated_at=excluded.updated_at,transcription=excluded.transcription').run(record.id,record.chunks.length,summary.durationMs,record.usage.samples,summary.pendingChunks,record.updatedAt,publicTranscription(record));
    },
    syncPg:sync,
    async ingest(owner,id,metadata,pcm){
      const bytes=Buffer.from(pcm);
      requireThat(bytes.length>0&&bytes.length<=480000&&bytes.length===metadata.sampleCount*2,'invalid_audio_size',400);
      requireThat(digest(bytes)===metadata.digest,'digest_mismatch',400);
      requireThat(typeof metadata.sessionId==='string'&&typeof metadata.epoch==='string','audio_session_mismatch',400);
      requireThat(Number.isSafeInteger(metadata.sequence)&&metadata.sequence>=0&&metadata.sequence<1000000,'invalid_sequence',400);
      const chunk={sessionId:metadata.sessionId,sourceId:metadata.sourceId,epoch:metadata.epoch,sequence:metadata.sequence,sampleOffset:metadata.sampleOffset,sampleCount:metadata.sampleCount,sampleRate:metadata.sampleRate,digest:metadata.digest,traceId:metadata.traceId,object:'preflight'};
      // No transaction spans the durable object write. Revalidate every fence after taking the write lock.
      const preview=await transaction((function*(){return yield* inspect(owned(yield* getHeader(id,true),owner),chunk);})());
      if(!preview.accepted)return preview.result;
      const object=await putAudio(id,bytes);
      const outcome=await transaction((function*(){
        const header=owned(yield* getHeader(id,true),owner);
        let result;
        const baseCursor=header.cursor,counts={...header.$counts},offsets={...header.$offsets};
        const checked=yield* inspect(header,{...chunk,...object});result=checked.result;
        if(checked.accepted){
          const accepted={...checked.accepted,waveform:chunkWaveform(bytes)},source=checked.source,sequence=accepted.sequence;
          yield write('INSERT INTO record_collections(record_id,field,position,data) VALUES($1,$2,$3,$4)',[id,'chunks',counts.chunks,JSON.stringify(accepted)]);
          for(const range of [checked.left,checked.right].filter(Boolean))yield write('DELETE FROM record_audio_ranges WHERE record_id=$1 AND source_id=$2 AND epoch=$3 AND start_seq=$4',[id,source.id,source.epoch,range[0]]);
          yield write('INSERT INTO record_audio_ranges(record_id,source_id,epoch,start_seq,end_seq) VALUES($1,$2,$3,$4,$5)',[id,source.id,source.epoch,checked.left?.[0]??sequence,checked.right?.[1]??sequence]);
          const event=header.events[0],eventOffset=offsets.events||0;
          yield write('INSERT INTO record_collections(record_id,field,position,data) VALUES($1,$2,$3,$4)',[id,'events',eventOffset+counts.events,JSON.stringify(event)]);
          if(counts.events===1000){yield write("DELETE FROM record_collections WHERE record_id=$1 AND field='events' AND position=$2",[id,eventOffset]);offsets.events=eventOffset+1;}else counts.events++;
          counts.chunks++;
          const summary=header.$audio;
          summary.pendingChunks++;summary.durationMs=Math.max(summary.durationMs,(source.timelineOffsetMs||0)+(accepted.sampleOffset+accepted.sampleCount)/16);
          summary.audio=header.sources.map(source=>source.id===result.sourceId?result:{...summary.audio.find(item=>item.sourceId===source.id),cursor:header.cursor});
          header.workAt ||= {};header.workAt.audio=Date.now();if(header.realtimeAudioConsent&&header.autoMinutes?.enabled&&header.capture!=='completed')header.workAt.realtime=Date.now();
          header.nextWorkAt=Math.min(...Object.values(header.workAt).filter(value=>typeof value==='number'));
          const set={cursor:header.cursor,updatedAt:header.updatedAt,usage:header.usage,sources:publicSources(header.sources),transcription:publicTranscription(header),audio:summary.audio,pendingChunks:summary.pendingChunks,durationMs:summary.durationMs,nextWorkAt:header.nextWorkAt};
          const first=raw((yield select("SELECT data FROM record_collections WHERE record_id=$1 AND field='events' ORDER BY position LIMIT 1",[id]))[0]).cursor;
          const metaRow=(yield select('SELECT data FROM record_feed_meta WHERE id=$1',[id]))[0];requireThat(metaRow,'storage_corrupt',500);const meta={...raw(metaRow),cursor:header.cursor,first,writeVersion:randomUUID()};
          const feed={...event,projection:true,delta:{baseCursor,cursor:header.cursor,set,remove:[],segments:{upsert:[],remove:[]}}};
          yield write('UPDATE record_feed_meta SET data=$2 WHERE id=$1',[id,JSON.stringify(meta)]);
          yield write('INSERT INTO record_feed_events(record_id,cursor,data) VALUES($1,$2,$3)',[id,cursorKey(event.cursor),JSON.stringify(feed)]);
          yield write('DELETE FROM record_feed_events WHERE record_id=$1 AND cursor<$2',[id,cursorKey(first)]);
          delete header.chunks;delete header.events;header.$counts=counts;header.$offsets=offsets;header.$version=randomUUID();
          if(pool)yield write('UPDATE record_aggregates SET data=$2 WHERE id=$1',[id,JSON.stringify(header)]);else sqliteStore.writeHeader(header);
          yield* stats(header,summary);
        }
        return {header,result,changed:Boolean(checked.accepted)};
      })());
      if(outcome.changed)committed([outcome.header],outcome.result);
      const result=outcome.result;
      return result;
    },
  };
}

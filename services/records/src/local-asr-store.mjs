import { randomUUID } from 'node:crypto';
import { requireThat, publicSources, publicTranscription } from '../../../packages/records/src/record.mjs';
import { cursorKey } from './projections.mjs';

const MAX_CHUNKS = 128, MAX_SAMPLES = 16000 * 30;
export async function createLocalAsrStore({ db, pool, sqliteStore, transaction, select, write, getHeader, stats, committed }) {
  const field = key => pool ? `data->>'${key}'` : `json_extract(data,'$.${key}')`;
  const sequence = pool ? `(${field('sequence')})::bigint` : field('sequence');
  const state = field('state'), source = field('sourceId'), epoch = field('epoch');
  const index = `CREATE INDEX IF NOT EXISTS local_asr_pending ON record_collections(record_id,(${source}),(${epoch}),(${sequence})) WHERE field='chunks' AND ${state}<>'done'`;
  const accepted = pool ? `COALESCE((data->>'acceptedAt')::bigint,0)` : "COALESCE(json_extract(data,'$.acceptedAt'),0)";
  const unexpired = pool ? "COALESCE((data->>'expired')::boolean,false)=false" : "COALESCE(json_extract(data,'$.expired'),0)=0";
  const expiryIndex=`CREATE INDEX IF NOT EXISTS local_asr_expiry ON record_collections(record_id,(${accepted})) WHERE field='chunks' AND ${unexpired}`;
  if (pool) {
    const client=await pool.connect();
    try { await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('lingji-local-asr-index-v1'))");await client.query(index);await client.query(expiryIndex);await client.query('COMMIT'); }
    catch(error) { await client.query('ROLLBACK');throw error; } finally {client.release();}
  } else { db.exec(index);db.exec(expiryIndex); }
  const decode = row => pool ? row.data : JSON.parse(row.data);
 function* view(id, _claim, lock) {
    const record = yield* getHeader(id, lock);
    if (!record || record.kind !== 'record') return null;
    requireThat(record.$collections === 2 && record.$audioVersion === 2 && record.$audio, 'storage_not_ready', 503);
    const rows = new Map();
    for (const item of record.sources) {
   // Every source contributes to the shared deadline, including during a single-source lease update.
   if (item.stopped && item.asr?.state === 'done') continue;
      const pending = yield select(`SELECT position,data FROM record_collections WHERE record_id=$1 AND field='chunks' AND ${source}=$2 AND ${epoch}=$3 AND ${state}<>'done' ORDER BY ${sequence} LIMIT ${MAX_CHUNKS + 1}`, [id,item.id,item.epoch]);
      for (const row of pending) rows.set(row.position, row);
      if (pending.length) {
        const following = pending.map(row => decode(row).sequence + 1);
        const neighbors = yield select(`SELECT position,data FROM record_collections WHERE record_id=$1 AND field='chunks' AND ${source}=$2 AND ${epoch}=$3 AND ${sequence} IN (${following.map((_, i) => '$' + (i + 4)).join(',')})`, [id,item.id,item.epoch,...following]);
        for (const row of neighbors) rows.set(row.position, row);
      }
    }
    const original = new Map([...rows].map(([position,row]) => { const value=decode(row);return [value.key,{position,json:JSON.stringify(value)}]; }));
    record.chunks=[...rows.values()].map(decode); record.events=[];
    return { record, original };
  }
  const immutableHeader = record => JSON.stringify({...record,sources:record.sources.map(({asr: _asr,...source})=>source),chunks:undefined,events:undefined,cursor:undefined,updatedAt:undefined,workAt:undefined,nextWorkAt:undefined});
  function nextAudio(record, streaming, now) {
    const due=[Date.parse(record.deleteAt),(record.gcAt || 0)+3600000];
    for (const item of record.sources) {
      if (item.asr?.state==='running' && item.asr.provider!=='sensevoice-local') due.push(now+250);
      const pending=record.chunks.filter(chunk=>chunk.sourceId===item.id && chunk.epoch===item.epoch && chunk.state!=='done').sort((a,b)=>a.sequence-b.sequence);
      const first=pending[0];if (!first || first.expired || first.attempts>=5 || first.sequence>item.watermark) continue;
      if ((first.lease || 0)>now) {due.push(first.lease);continue;}
      const online=streaming && ['auto','zh','en'].includes(record.language) && (!item.asr?.streamingLanguage || ['zh','en'].includes(item.asr.streamingLanguage)) && (item.asr?.previewRetryAt || 0)<=now;
      const fresh=online && item.watermark>(item.asr?.streamedWatermark ?? -1);
      if ((first.retryAt || 0)>now && !(first.batchWaiting && (item.stopped || fresh))) {due.push(first.retryAt);continue;}
      let samples=0,last;
      for (const chunk of pending) {
        if (chunk.sequence>item.watermark || chunk.expired || chunk.attempts>=5 || (chunk.lease || 0)>now || (last && (chunk.sequence!==last.sequence+1 || chunk.sampleOffset!==last.sampleOffset+last.sampleCount)) || samples+chunk.sampleCount>MAX_SAMPLES) break;
        samples+=chunk.sampleCount;last=chunk;
        if (samples>=MAX_SAMPLES) break;
      }
      if (!last) continue;
      const boundary=record.chunks.some(chunk=>chunk.sourceId===item.id && chunk.epoch===item.epoch && chunk.sequence===last.sequence+1 && chunk.state==='done');
      if (item.stopped && item.watermark<item.lastSequence && samples<MAX_SAMPLES && !boundary) continue;
      due.push(item.stopped || boundary || samples>=16000*(online?1:2) ? now : (first.acceptedAt || now)+20000);
    }
    return Math.min(...due.filter(Number.isFinite));
  }
  function schedule(record, streaming) {
    const now=Date.now();record.workAt ||= {}; record.workAt.audio=nextAudio(record,streaming,now);
    for (const source of record.sources) {
      const preview=source.asr?.preview,translation=source.asr?.translation;
      if (record.translationTarget && source.asr?.state==='running' && preview?.text?.trim().length>=4 && !(translation?.target===record.translationTarget && translation.sourceText===preview.text && translation.text) && (translation?.requestedText!==preview.text || (translation?.attempts || 0)<3)) {
        record.workAt['translation-preview']=Math.max(now,translation?.lease || 0,(translation?.requestedAt || 0)+2500);
      }
    }
    record.nextWorkAt=Math.min(...Object.values(record.workAt).filter(value=>typeof value==='number' && Number.isFinite(value)));
  }
  function* persist(record, original, before, events) {
    const cacheRows=[];
    for (const chunk of record.chunks) {
      const previous=original.get(chunk.key),json=JSON.stringify(chunk);
      requireThat(previous, 'invalid_local_asr_mutation', 500);
      if (json!==previous.json) {
        yield write("UPDATE record_collections SET data=$3 WHERE record_id=$1 AND field='chunks' AND position=$2",[record.id,previous.position,json]);
        cacheRows.push({field:'chunks',position:previous.position,data:json});
      }
    }
    const counts={...record.$counts},offsets={...record.$offsets},summary=record.$audio;
    if (events.length) {
      const metaRow=(yield select('SELECT data FROM record_feed_meta WHERE id=$1',[record.id]))[0]; requireThat(metaRow,'storage_corrupt',500);
      const meta={...decode(metaRow),cursor:record.cursor,writeVersion:randomUUID()};
      let previousCursor=before.cursor;
      for (const event of events) {
        cacheRows.push({field:'events',position:(offsets.events || 0)+counts.events,data:JSON.stringify(event)});
        yield write('INSERT INTO record_collections(record_id,field,position,data) VALUES($1,$2,$3,$4)',[record.id,'events',(offsets.events || 0)+counts.events,JSON.stringify(event)]);
        if (counts.events===1000) {yield write("DELETE FROM record_collections WHERE record_id=$1 AND field='events' AND position=$2",[record.id,offsets.events || 0]);offsets.events=(offsets.events || 0)+1;} else counts.events++;
    summary.audio=summary.audio.map(receipt=>({...receipt,cursor:event.cursor}));
    const set={cursor:event.cursor,updatedAt:record.updatedAt,sources:publicSources(record.sources),transcription:publicTranscription(record),audio:summary.audio,nextWorkAt:record.nextWorkAt};
        const feed={...event,projection:true,delta:{baseCursor:previousCursor,cursor:event.cursor,set,remove:[],segments:{upsert:[],remove:[]}}};
        yield write('INSERT INTO record_feed_events(record_id,cursor,data) VALUES($1,$2,$3)',[record.id,cursorKey(event.cursor),JSON.stringify(feed)]);previousCursor=event.cursor;
      }
      meta.first=decode((yield select("SELECT data FROM record_collections WHERE record_id=$1 AND field='events' ORDER BY position LIMIT 1",[record.id]))[0]).cursor;
      yield write('UPDATE record_feed_meta SET data=$2 WHERE id=$1',[record.id,JSON.stringify(meta)]);
      yield write('DELETE FROM record_feed_events WHERE record_id=$1 AND cursor<$2',[record.id,cursorKey(meta.first)]);

    }
    record.$counts=counts;record.$offsets=offsets;record.$version=randomUUID();
    delete record.chunks;delete record.events;
    if (pool) yield write('UPDATE record_aggregates SET data=$2 WHERE id=$1',[record.id,JSON.stringify(record)]); else sqliteStore.writeHeader(record,false,{baseVersion:before.baseVersion,rows:cacheRows});
    yield* stats(record,summary);
  }
  return {
    async localAsrNeedsCleanup(record) {
      if (record.retainAudio || Date.now()-Date.parse(record.createdAt)<86400000) return false;
      return transaction((function*(){return (yield select(`SELECT 1 AS found FROM record_collections WHERE record_id=$1 AND field='chunks' AND ${unexpired} AND ${accepted}<=$2 LIMIT 1`,[record.id,Date.now()-86400000])).length>0;})());
    },
    localAsrTail: id => transaction((function*(){return (yield select("SELECT data FROM record_collections WHERE record_id=$1 AND field='segments' ORDER BY position DESC LIMIT 3",[id])).map(decode).reverse();})()),
    inspectLocalAsr: (id, claim) => transaction((function*(){return (yield* view(id,claim,false))?.record || null;})()),
    async changeLocalAsr(id, claim, operation, { streaming=false }={}) {
      const outcome=await transaction((function*(){
        const selected=yield* view(id,claim,true);if (!selected) return {changed:false};
        const {record,original}=selected;
        if (record.deleted || Date.parse(record.deleteAt)<=Date.now()) return {changed:false};
        const before={baseVersion:record.$version,cursor:record.cursor,immutable:immutableHeader(record),header:JSON.stringify({...record,chunks:undefined,events:undefined})};
        const result=operation(record);requireThat(!result?.then,'invalid_local_asr_mutation',500);
        requireThat(immutableHeader(record)===before.immutable,'invalid_local_asr_mutation',500);
        schedule(record,streaming);
        const changed=record.events.length || before.header!==JSON.stringify({...record,chunks:undefined,events:undefined}) || record.chunks.some(chunk=>JSON.stringify(chunk)!==original.get(chunk.key)?.json);
        if (changed) yield* persist(record,original,before,record.events);
        return {changed:Boolean(changed),record,result};
      })());
      if (outcome.changed) committed([outcome.record],outcome.result);
      return outcome.result;
    },
  };
}

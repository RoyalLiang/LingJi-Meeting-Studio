import {updateTranscriptPreview} from '../../../packages/records/src/speakers.mjs';
import { randomUUID } from 'node:crypto';
import { requireThat, publicJobs, privateJobFields, publicSources } from '../../../packages/records/src/record.mjs';
import { updateMinutesPreview } from '../../../packages/records/src/automation.mjs';
import { cursorKey } from './projections.mjs';

// These writes preserve frozen inputs and all unrelated collection/document rows.
export async function createLiveFieldStore({ pool, sqliteStore, postgresStore, transaction, select, write, getHeader, committed }) {
  const decode = row => pool ? row.data : JSON.parse(row.data);
  const json = key => pool ? `data->>'${key}'` : `json_extract(data,'$.${key}')`;
  const number = key => pool ? `COALESCE((${json(key)})::double precision,0)` : `COALESCE(${json(key)},0)`;
  const hidden = privateJobFields.filter(key => key !== 'fence');
  const jobsView = pool ? `data - ARRAY[${hidden.map(key => `'${key}'`).join(',')}]` : `json_remove(data,${hidden.map(key => `'$.${key}'`).join(',')})`;
  const pending = `field='segments' AND ${number('translationAttempts')}<3 AND ${number('translationPending')}=1`;
  const retryDue = pool ? `GREATEST(${number('translationLease')},${number('translationRetryAt')})` : `MAX(${number('translationLease')},${number('translationRetryAt')})`;
  await transaction((function* () {
    if (pool) yield select("SELECT pg_advisory_xact_lock(hashtext('lingji-live-field-index-v1'))", []);
    for (const key of ['id','endMs']) {
      const expression = key === 'id' ? json(key) : number(key);
      yield write(`CREATE INDEX IF NOT EXISTS record_segment_${key === 'id' ? 'identity' : 'end'} ON record_collections(record_id,(${expression})) WHERE field='segments'`, []);
    }
  })());

  await transaction((function* () {
    if(pool)yield select("SELECT pg_advisory_xact_lock(hashtext('lingji-live-field-index-v1'))",[]);
    yield write(`CREATE INDEX IF NOT EXISTS record_translation_unindexed ON record_collections(record_id) WHERE field='segments' AND ${json('translationPending')} IS NULL`,[]);
    const records=yield select(`SELECT DISTINCT record_id FROM record_collections WHERE field='segments' AND ${json('translationPending')} IS NULL`,[]);
    for(const {record_id:id} of records){
      const header=yield* getHeader(id,true);
      const expression=`CASE WHEN COALESCE($2,'')<>'' AND COALESCE(${json('translationLanguage')},'')<>$2 AND ${number('translationAttempts')}<3 THEN 1 ELSE 0 END`;
      const data=pool ? `jsonb_set(data,'{translationPending}',to_jsonb(${expression}))` : `json_set(data,'$.translationPending',${expression})`;
      yield write(`UPDATE record_collections SET data=${data} WHERE record_id=$1 AND field='segments' AND ${json('translationPending')} IS NULL`,[id,header?.translationTarget||'']);
    }
    yield write(`CREATE INDEX IF NOT EXISTS record_translation_pending ON record_collections(record_id,position) WHERE ${pending}`,[]);
    yield write(`CREATE INDEX IF NOT EXISTS record_translation_due ON record_collections(record_id,(${retryDue})) WHERE ${pending}`,[]);
  })());
  function immutableTranslation(record) {
    const { events, segments, cursor, updatedAt, ...header } = record;
    header.sources = header.sources.map(source => {
      if (!source.asr) return source;
      const { translation, ...asr } = source.asr;
      return { ...source, asr };
    });
    return JSON.stringify([header,segments.map(segment => Object.fromEntries(Object.entries(segment).filter(([key]) => !key.startsWith('translation'))))]);
  }

  function* persist(record, before, rows, set, segments = []) {
    const counts = { ...record.$counts }, offsets = { ...record.$offsets };
    const events = record.events;
    let previousCursor = before.cursor;
    for (const event of events) {
      const position = (offsets.events || 0) + counts.events, data = JSON.stringify(event);
      yield write('INSERT INTO record_collections(record_id,field,position,data) VALUES($1,$2,$3,$4)', [record.id,'events',position,data]);
      rows.push({ field:'events', position, data });
      if (counts.events === 1000) {
        yield write("DELETE FROM record_collections WHERE record_id=$1 AND field='events' AND position=$2", [record.id,offsets.events || 0]);
        offsets.events = (offsets.events || 0) + 1;
      } else counts.events++;
      record.$audio.audio = record.$audio.audio.map(receipt => ({ ...receipt, cursor:event.cursor }));
      const delta = { baseCursor:previousCursor, cursor:event.cursor, set:{ ...set, audio:record.$audio.audio, cursor:event.cursor, updatedAt:record.updatedAt, nextWorkAt:record.nextWorkAt }, remove:[], segments:{ upsert:segments, remove:[] } };
      yield write('INSERT INTO record_feed_events(record_id,cursor,data) VALUES($1,$2,$3)', [record.id,cursorKey(event.cursor),JSON.stringify({ ...event, projection:true, delta })]);
      previousCursor = event.cursor;
    }
    if (events.length) {
      const meta = decode((yield select('SELECT data FROM record_feed_meta WHERE id=$1', [record.id]))[0]);
      const first = decode((yield select("SELECT data FROM record_collections WHERE record_id=$1 AND field='events' ORDER BY position LIMIT 1", [record.id]))[0]).cursor;
      Object.assign(meta, { first, cursor:record.cursor, writeVersion:randomUUID() });
      yield write('UPDATE record_feed_meta SET data=$2 WHERE id=$1', [record.id,JSON.stringify(meta)]);
      yield write('DELETE FROM record_feed_events WHERE record_id=$1 AND cursor<$2', [record.id,cursorKey(first)]);
      yield write('UPDATE record_audio_stats SET updated_at=$2 WHERE record_id=$1', [record.id,record.updatedAt]);
    }
    record.$counts = counts; record.$offsets = offsets; record.$version = randomUUID();
    delete record.jobs; delete record.segments; delete record.events;
    delete record.chunks;
    if (pool) { yield write('UPDATE record_aggregates SET data=$2 WHERE id=$1', [record.id,JSON.stringify(record)]);postgresStore.patchHeader(record,{baseVersion:before.version,rows}); }
    else sqliteStore.writeHeader(record, false, { baseVersion:before.version, rows });
  }

  async function change(id, selector, operation) {
    const outcome = await transaction((function* () {
      const record = yield* getHeader(id, true);
      if (!record || record.deleted || Date.parse(record.deleteAt) <= Date.now()) return {};
      if (record.$collections !== 2) return { unsupported:true };
      const before = { version:record.$version, cursor:record.cursor };
      record.events = [];
      if (selector.sourceId) {
        const source=record.sources.find(item=>item.id===selector.sourceId);
        if (record.generation!==selector.generation || source?.asr?.fence!==selector.fence || source.asr.state!=='running') return {};
        const needsFirst=selector.preview?.value?.text && source.asr.runtime?.firstUiReadyMs===undefined;
        const selected=selector.chunkKey || needsFirst ? yield select(`SELECT position,data FROM record_collections WHERE record_id=$1 AND field='chunks' AND ${json('sourceId')}=$2 AND ${json('epoch')}=$3 AND ${json('sequence')}=$4`,[id,source.id,source.epoch,pool?String(selector.sequence??0):(selector.sequence??0)]) : [];
        record.chunks=selected.map(decode);
        const beforeSource=JSON.stringify(source.asr), beforeChunks=JSON.stringify(record.chunks);
        if (selector.preview) updateTranscriptPreview(record,source.id,selector.fence,selector.preview.value,selector.preview.runtime,selector.generation);
        if (selector.sequence!==undefined) {
          if (source.asr.lastFedSequence+1!==selector.sequence || record.chunks[0]?.sequence!==selector.sequence || selector.sequence>source.watermark) return {};
          source.asr.lastFedSequence=selector.sequence; record.chunks[0].state='streaming';
        }
        if (selector.lease) source.asr.lease=selector.lease;
        if (selector.ended && source.stopped && source.watermark===source.lastSequence && source.asr.lastFedSequence===source.lastSequence) source.asr.ended=true;
        if (beforeSource===JSON.stringify(source.asr) && beforeChunks===JSON.stringify(record.chunks) && !record.events.length) return {};
        const rows=[];
        if (beforeChunks!==JSON.stringify(record.chunks)) {
          const data=JSON.stringify(record.chunks[0]);
          yield write("UPDATE record_collections SET data=$3 WHERE record_id=$1 AND field='chunks' AND position=$2",[id,selected[0].position,data]);
          rows.push({field:'chunks',position:selected[0].position,data});
        }
        yield* scheduleTranslation(record,Date.now());
        yield* persist(record,before,rows,{sources:publicSources(record.sources)},[]);
        return {record};
      }
      if (selector.jobId) {
        const jobs = yield select(`SELECT position,${jobsView} AS data FROM record_collections WHERE record_id=$1 AND field='jobs' ORDER BY position`, [id]);
        record.jobs = jobs.map(decode);
        updateMinutesPreview(record, selector.jobId, selector.fence, selector.text, selector.runtime);
        if (!record.events.length) return {};
        const index = record.jobs.findIndex(job => job.id === selector.jobId), job = record.jobs[index];
        const remove = job.runtime === undefined ? ['runtime'] : [];
        const patch = { preview:job.preview, ...(job.runtime === undefined ? {} : { runtime:job.runtime }) };
        const expression = pool
          ? "(data - 'runtime') || $3::jsonb"
          : `json_set(json_remove(data,'$.runtime'),'$.preview',json_extract($3,'$.preview')${remove.length ? '' : ",'$.runtime',json_extract($3,'$.runtime')"})`;
        yield write(`UPDATE record_collections SET data=${expression} WHERE record_id=$1 AND field='jobs' AND position=$2`, [id,jobs[index].position,JSON.stringify(patch)]);
        yield* persist(record, before, [{ field:'jobs',position:jobs[index].position,set:patch,remove }], { jobs:publicJobs(record.jobs) });
      } else {
        const now = Date.now(), mode = selector.mode;
        let selected = [];
        if (selector.claim?.kind === 'segment') {
          selected = yield select(`SELECT position,data FROM record_collections WHERE record_id=$1 AND field='segments' AND ${json('id')}=$2 LIMIT 1`, [id,selector.claim.id]);
        } else if (!selector.claim && mode !== 'preview' && record.translationTarget) {
          const params = [id,record.translationTarget,now];
          let live = '';
          if (mode === 'live') {
            const max = (yield select(`SELECT MAX(${number('endMs')}) AS end_ms FROM record_collections WHERE record_id=$1 AND field='segments'`, [id]))[0].end_ms || 0;
            live = ` AND ${number('endMs')}>=$4`; params.push(record.translationLiveFromMs ?? max);
          }
          selected = yield select(`SELECT position,data FROM record_collections WHERE record_id=$1 AND ${pending} AND COALESCE(${json('translationLanguage')},'')<>$2 AND ${number('translationAttempts')}<3 AND ${number('translationLease')}<=$3 AND ${number('translationRetryAt')}<=$3${live} ORDER BY ${mode === 'live' ? `${number('startMs')} DESC` : 'position'} LIMIT 1`, params);
        }
        record.segments = selected.map(decode);
        // Keep the original live-window boundary when the callback sees only one row.
        const originalLiveFrom = record.translationLiveFromMs;
        if (mode === 'live' && originalLiveFrom === undefined && selected.length) record.translationLiveFromMs = (yield select(`SELECT MAX(${number('endMs')}) AS end_ms FROM record_collections WHERE record_id=$1 AND field='segments'`, [id]))[0].end_ms || 0;
        const headerBefore = JSON.stringify(record.sources), segmentBefore = JSON.stringify(record.segments);
        const immutable = immutableTranslation(record);
        const result = operation(record);
        requireThat(!result?.then, 'invalid_live_field_mutation', 500);
        requireThat(immutableTranslation(record) === immutable, 'invalid_live_field_mutation', 500);
        if (originalLiveFrom === undefined) delete record.translationLiveFromMs;
        const rows = [], upsert = [];
        if (JSON.stringify(record.segments) !== segmentBefore) {
          requireThat(selected.length === 1 && record.segments.length === 1 && record.segments[0].id === decode(selected[0]).id, 'invalid_live_field_mutation', 500);
          record.segments[0].translationPending=Number(Boolean(record.translationTarget && record.segments[0].translationLanguage!==record.translationTarget && (record.segments[0].translationAttempts||0)<3));
          const data = JSON.stringify(record.segments[0]);
          yield write("UPDATE record_collections SET data=$3 WHERE record_id=$1 AND field='segments' AND position=$2", [id,selected[0].position,data]);
          rows.push({ field:'segments',position:selected[0].position,data });
          const { translationLease, translationFence, translationPending, ...segment } = record.segments[0];
          upsert.push(segment);
        }
        if (!rows.length && headerBefore === JSON.stringify(record.sources) && !record.events.length) return {};
        yield* scheduleTranslation(record, now);
        yield* persist(record, before, rows, { ...(headerBefore === JSON.stringify(record.sources) ? {} : { sources:publicSources(record.sources) }) }, upsert);
      }
      return { record };
    })());
    if (outcome.record) committed([outcome.record]);
    return outcome;
  }

  function* scheduleTranslation(record, now) {
    record.workAt ||= {};
    const base = record.translationTarget && !record.deleted ? '' : ' AND 1=0';
    const query = `SELECT ${retryDue} AS due FROM record_collections WHERE record_id=$1 AND ${pending}${base}`;
    const next=(rows)=>rows.length ? Math.max(now,Number(rows[0].due)) : null;
    record.workAt.translation = next(yield select(`${query} ORDER BY ${retryDue} LIMIT 1`,[record.id]));
    const max = record.capture==='recording' ? (record.translationLiveFromMs ?? (yield select(`SELECT MAX(${number('endMs')}) AS end_ms FROM record_collections WHERE record_id=$1 AND field='segments'`,[record.id]))[0].end_ms ?? 0) : 0;
    record.workAt['translation-live'] = record.capture==='recording' ? next(yield select(`${query} AND ${number('endMs')}>=$2 ORDER BY ${retryDue} LIMIT 1`,[record.id,max])) : null;
    const previews = record.sources.filter(source => {
      const preview = source.asr?.preview, value = source.asr?.translation;
      return record.translationTarget && source.asr?.state === 'running' && preview?.text?.trim().length >= 4 && !(value?.target === record.translationTarget && value.sourceText === preview.text && value.text) && (value?.requestedText !== preview.text || (value?.attempts || 0) < 3);
    });
    record.workAt['translation-preview'] = previews.length ? Math.min(...previews.map(source => Math.max(now,source.asr.translation?.lease || 0,(source.asr.translation?.requestedAt || 0) + 2500))) : null;
    record.nextWorkAt = Math.min(...Object.values(record.workAt).filter(Number.isFinite));
  }

  return {
    changeSpeech: (id,selector)=>change(id,selector),
    changeMinutesPreview: (id, jobId, fence, text, runtime) => change(id, { jobId,fence,text,runtime }),
    changeTranslation: (id, selector, operation) => change(id, selector, operation),
  };
}

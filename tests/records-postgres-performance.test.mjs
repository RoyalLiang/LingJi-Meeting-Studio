import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,addSource,digest} from '../packages/records/src/record.mjs';
import {searchGrams} from '../services/records/src/record-search.mjs';
import {createPostgresRecordStore} from '../services/records/src/postgres-record-store.mjs';
import {encodedCollections,encodedDocuments,storageHeader} from '../services/records/src/record-storage-shape.mjs';

test('Postgres v2 list hydrates its prefetched collections and documents', async () => {
  const record = createRecord('pg-read-test', {title:'会议'});
  const collections = encodedCollections(record), documents = encodedDocuments(record);
  const header = storageHeader(record, collections, documents, randomUUID());
  const client = {
    async query(sql) {
      if (sql.startsWith('SELECT id,data FROM record_aggregates')) return {rows:[{id:record.id,data:header}]};
      if (sql.includes('FROM record_collections WHERE record_id=ANY')) {
        return {rows:Object.entries(collections).flatMap(([field, rows])=>
          rows.map((data,position)=>({record_id:record.id,field,position,data:JSON.parse(data)})))};
      }
      if (sql.includes('FROM record_documents WHERE record_id=ANY')) {
        return {rows:Object.entries(documents).map(([field, data])=>({record_id:record.id,field,data:JSON.parse(data)}))};
      }
      assert.match(sql, /^(?:BEGIN |COMMIT$)/);
      return {rows:[]};
    },
    release() {},
  };
  const store = await createPostgresRecordStore({query:async()=>({rows:[]}),connect:async()=>client});
  const [hydrated] = await store.list('record');
  assert.equal(hydrated.id, record.id);
  assert.equal(hydrated.title, record.title);
  assert.deepEqual(hydrated.segments, []);
});

test('Postgres CJK and mixed-case knowledge search share indexed grams and warm speech writes preserve snapshots',{skip:!process.env.RECORD_TEST_DATABASE_URL},async t=>{
  const databaseUrl=process.env.RECORD_TEST_DATABASE_URL;assert.match(new URL(databaseUrl).pathname,/test/i);
 const root=await mkdtemp(join(tmpdir(),'postgres-performance-')),repo=await createRepository({root,databaseUrl,compressAudio:true});
  const pg=await import('pg'),pool=new pg.Pool({connectionString:databaseUrl});t.after(async()=>{await pool.end();await repo.close();await rm(root,{recursive:true,force:true});});
  const owner='index-test-'+randomUUID(),record=createRecord(owner,{title:'Project 上海会议'}),source=addSource(record,{kind:'microphone'});source.asr={state:'running',fence:'current',lastFedSequence:-1};record.gcAt=Date.now();record.jobs=[{id:'frozen',status:'running',snapshot:{text:'x'.repeat(100000)}}];await repo.insert(record);
  const bytes=Buffer.alloc(32000,1);await repo.ingestAudio(owner,record.id,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:16000,sampleRate:16000,digest:digest(bytes)},bytes);
  assert.equal((await repo.listSummaries(owner,'all','上海'))[0].id,record.id);
  const entry={id:'b'.repeat(64),recordId:record.id,text:'Project 上海方案',topic:'',topicKey:'',kind:'fact',status:'confirmed',createdAt:new Date().toISOString(),evidence:[],generation:record.generation,minutesRevision:1,transcriptRevision:1,reviewRevision:1};
  await pool.query('INSERT INTO record_knowledge(id,record_id,owner,workspace,expires,data,grams,grams_version) VALUES($1,$2,$3,$4,$5,$6,$7,4)',[entry.id,record.id,owner,'inbox',record.deleteAt,JSON.stringify(entry),searchGrams(entry.text)]);
  assert.equal((await repo.listKnowledge(owner,'all',{query:'project'})).entries[0].id,entry.id);
  assert.equal((await repo.retrieveKnowledge(owner,'all','上海')).entries[0].id,entry.id);
  const warm=await repo.get(record.id),key=warm.chunks[0].key,query=pg.Client.prototype.query;
  pg.Client.prototype.query=function(sql,...args){assert.doesNotMatch(typeof sql==='string'?sql:sql.text,/SELECT field,position,data FROM record_collections/,'warm partial write must not rehydrate history');return query.call(this,sql,...args);};
  try{
    await repo.changeSpeech(record.id,{sourceId:source.id,fence:'current',generation:record.generation,sequence:0,chunkKey:key});
    await repo.changeSpeech(record.id,{sourceId:source.id,fence:'current',generation:record.generation,preview:{value:{text:'实时草稿'},runtime:{}}});
    const updated=await repo.get(record.id);assert.equal(updated.sources[0].asr.lastFedSequence,0);assert.equal(updated.sources[0].asr.preview.text,'实时草稿');assert.equal(updated.jobs[0].snapshot.text.length,100000);
 }finally{pg.Client.prototype.query=query;}
 const second=Buffer.alloc(32000,2);await repo.ingestAudio(owner,record.id,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:1,sampleOffset:16000,sampleCount:16000,sampleRate:16000,digest:digest(second)},second);
 await repo.change(record.id,value=>{value.capture='completed';value.retainAudio=true;value.chunks.forEach(chunk=>chunk.state='done');});
 const completed=await repo.get(record.id),directory=join(root,'audio',record.id);let beforeBytes=0;for(const file of await readdir(directory))beforeBytes+=(await readFile(join(directory,file))).length;
 await repo.archiveAudio(completed);
 const files=await readdir(directory);assert.equal(files.length,1);assert.match(files[0],/\.pcm\.pack$/);assert.equal((await readFile(join(directory,files[0]))).length,beforeBytes);
 const offsets=(await pool.query('SELECT byte_offset,byte_length FROM record_audio_archive_offsets WHERE record_id=$1 ORDER BY sequence',[record.id])).rows;assert.equal(offsets.length,2);assert.equal(Number(offsets[1].byte_offset),Number(offsets[0].byte_length));
 const restarted=await createRepository({root,databaseUrl});try{assert.deepEqual(await restarted.readAudio(completed.chunks[0].object),bytes);assert.deepEqual(await restarted.readAudio(completed.chunks[1].object),second);}finally{await restarted.close();}
});

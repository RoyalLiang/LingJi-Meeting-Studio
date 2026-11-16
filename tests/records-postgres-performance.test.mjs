import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,addSource,digest} from '../packages/records/src/record.mjs';
import {searchGrams} from '../services/records/src/record-search.mjs';

test('Postgres CJK and mixed-case knowledge search share indexed grams and warm speech writes preserve snapshots',{skip:!process.env.RECORD_TEST_DATABASE_URL},async t=>{
  const databaseUrl=process.env.RECORD_TEST_DATABASE_URL;assert.match(new URL(databaseUrl).pathname,/test/i);
  const root=await mkdtemp(join(tmpdir(),'postgres-performance-')),repo=await createRepository({root,databaseUrl});
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
});

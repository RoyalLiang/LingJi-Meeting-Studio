import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord, addSource, acknowledge, digest, publicRecord, emit } from '../packages/records/src/record.mjs';

for (const driver of ['sqlite','postgres']) test(`${driver} bounded ASR preserves other-source deadlines and partial feed receipts`, {skip:driver==='postgres'&&!process.env.RECORD_TEST_DATABASE_URL}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-local-asr-store-'));
 const databaseUrl=driver==='postgres'?process.env.RECORD_TEST_DATABASE_URL:undefined;
 if(databaseUrl) assert.match(new URL(databaseUrl).pathname,/test/i);
 const repo=await createRepository({root,databaseUrl});
 const record=createRecord('local-asr-store-synthetic',{language:'zh',autoMinutes:false});
 t.after(async()=>{
  if(databaseUrl){
   const {Pool}=await import('pg'),sql=new Pool({connectionString:databaseUrl});
   for(const table of ['record_feed_events','record_collections','record_documents','record_collection_backups','record_audio_stats','record_audio_ranges','record_knowledge','record_knowledge_state']) await sql.query(`DELETE FROM ${table} WHERE record_id=$1`,[record.id]);
   for(const table of ['record_aggregates','record_feed_meta','record_list_projection']) await sql.query(`DELETE FROM ${table} WHERE id=$1`,[record.id]);
   await sql.end();
  }
  await repo.close();await rm(root,{recursive:true,force:true});
 });
 const one=addSource(record,{kind:'microphone'}),two=addSource(record,{kind:'display'}),bytes=Buffer.alloc(64000);
 record.gcAt=Date.now();
 for(const source of [one,two]){
  const stored=await repo.putAudio(record.id,bytes);
  acknowledge(record,{...stored,sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:32000,sampleRate:16000,digest:digest(bytes)});
  source.asr={provider:'sensevoice-local',state:'running',streamingLanguage:'zh'};
 }
 one.stopped=true;one.lastSequence=1;
 Object.assign(record.chunks[0],{state:'processing',fence:'synthetic-fence',lease:Date.now()+180000});
 await repo.insert(record);
 await repo.changeLocalAsr(record.id,{sourceId:one.id,epoch:one.epoch},r=>{
  const chunk=r.chunks.find(c=>c.fence==='synthetic-fence');chunk.state='pending';delete chunk.fence;delete chunk.lease;
 },{streaming:true});
 const before=await repo.get(record.id);
 assert.ok(before.workAt.audio<=Date.now()+1000,'ready second source must remain runnable');
 assert.ok((await repo.listWork({lane:'audio',metadataOnly:true})).some(r=>r.id===record.id));
 await repo.changeLocalAsr(record.id,{sourceId:one.id,epoch:one.epoch},r=>{
  r.sources[0].asr.preview={text:'synthetic draft',startMs:0,updatedAt:Date.now()};emit(r,'asr.partial',{sourceId:one.id});
 },{streaming:true});
 const replay=publicRecord(before),feed=await repo.eventsAfter(record.id,before.cursor);
 for(const event of feed.events){Object.assign(replay,event.delta.set);for(const key of event.delta.remove)delete replay[key];}
 const after=publicRecord(await repo.get(record.id));
 assert.deepEqual(replay.audio,after.audio);assert.deepEqual(replay.transcription,after.transcription);
 await assert.rejects(repo.changeLocalAsr(record.id,null,r=>{r.title='must not overwrite user content';}),/invalid_local_asr_mutation/);
 assert.equal((await repo.get(record.id)).title,before.title);
});

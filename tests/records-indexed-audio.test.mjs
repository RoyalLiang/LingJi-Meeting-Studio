import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{createRepository}from'../services/records/src/repository.mjs';import{createRecord,addSource,digest,publicRecord}from'../packages/records/src/record.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'indexed-audio-')),repo=await createRepository({root,databaseUrl:''}),record=createRecord('owner'),source=addSource(record,{kind:'microphone'});await repo.insert(record);t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});return{root,repo,record,source};}
function audio(source,sequence){const bytes=Buffer.alloc(320,sequence+1);return{bytes,metadata:{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*160,sampleCount:160,sampleRate:16000,digest:digest(bytes)}};}
test('indexed ingestion preserves durable identity, holes, source fences and exact public delta',async t=>{
 const{repo,record,source}=await fixture(t),second=audio(source,1),first=audio(source,0),before=publicRecord(record);
 const one=await repo.ingestAudio('owner',record.id,second.metadata,second.bytes);assert.equal(one.watermark,-1);assert.deepEqual(one.missing,[0]);
 const two=await repo.ingestAudio('owner',record.id,first.metadata,first.bytes);assert.equal(two.watermark,1);assert.deepEqual(two.missing,[]);
 const after=await repo.get(record.id);assert.equal(after.chunks.length,2);assert.equal(after.usage.samples,320);assert.equal(after.sources[0].watermark,1);assert.deepEqual(await repo.readAudio(after.chunks[0].object),second.bytes);
 const duplicate=await repo.ingestAudio('owner',record.id,first.metadata,first.bytes);assert.equal(duplicate.cursor,two.cursor);assert.equal((await repo.get(record.id)).chunks.length,2);
 await assert.rejects(repo.ingestAudio('other',record.id,first.metadata,first.bytes),{code:'not_found'});
 const wrong=Buffer.alloc(320,100);await assert.rejects(repo.ingestAudio('owner',record.id,{...first.metadata,digest:digest(wrong)},wrong),{code:'audio_identity_conflict'});
 const feed=await repo.eventsAfter(record.id,before.cursor);let value=before;
 for(const event of feed.events){const d=event.delta;assert.equal(d.baseCursor,value.cursor);value={...value,...d.set};for(const key of d.remove)delete value[key];}
 assert.deepEqual(value,publicRecord(after));
});

test('ACK point reads and row writes stay bounded from 10k to 100k historical chunks',async t=>{
 const {DatabaseSync}=await import('node:sqlite'),{repo,root}=await fixture(t),results=[];
 for(const count of [10000,100000]){
  const record=createRecord('owner'),source=addSource(record,{kind:'microphone'});source.watermark=count-1;
  record.chunks=Array.from({length:count},(_,sequence)=>({key:`${source.sessionId}:${source.id}:${source.epoch}:${sequence}`,sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*160,sampleCount:160,sampleRate:16000,digest:'legacy-fixture',object:'fixture',state:'done',attempts:0}));record.usage.samples=count*160;
  await repo.insert(record);record.chunks=[];
  const audit=new DatabaseSync(join(root,'records.sqlite'));audit.exec('CREATE TABLE IF NOT EXISTS audio_row_writes(n INTEGER);DELETE FROM audio_row_writes;CREATE TRIGGER IF NOT EXISTS count_audio_insert AFTER INSERT ON record_collections BEGIN INSERT INTO audio_row_writes VALUES(1);END;CREATE TRIGGER IF NOT EXISTS count_audio_update AFTER UPDATE ON record_collections BEGIN INSERT INTO audio_row_writes VALUES(1);END');
  const prepare=DatabaseSync.prototype.prepare,queries=[];
  DatabaseSync.prototype.prepare=function(sql,...args){assert.doesNotMatch(sql,/SELECT field,position,data FROM record_collections WHERE record_id=\? ORDER BY field,position/,'ACK must not hydrate collections');queries.push(sql);return prepare.call(this,sql,...args);};
  let elapsed;try{const next=audio(source,count),start=performance.now();await repo.ingestAudio('owner',record.id,next.metadata,next.bytes);elapsed=performance.now()-start;}finally{DatabaseSync.prototype.prepare=prepare;}
  const writes=audit.prepare('SELECT count(*) AS n FROM audio_row_writes').get().n;assert.equal(writes,2,'only one chunk and one event are written');
  const stored=JSON.parse(audit.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data);assert.equal(stored.$counts.chunks,count+1);assert.equal(stored.$audio.pendingChunks,1);assert.ok(JSON.stringify(stored).length<5000);
  results.push({count,queries:queries.length,writes,elapsed});audit.close();
 }
 assert.equal(results[0].queries,results[1].queries);t.diagnostic(JSON.stringify(results));
});

test('event ring survives 1000 ACKs, ordinary mutations, rollback and reopen',async t=>{
 const{repo,root,record,source}=await fixture(t);
 for(let sequence=0;sequence<1010;sequence++){const chunk=audio(source,sequence);await repo.ingestAudio('owner',record.id,chunk.metadata,chunk.bytes);}
 const after=await repo.get(record.id);assert.equal(after.events.length,1000);assert.equal(after.chunks.length,1010);assert.equal(after.sources[0].watermark,1009);
 await repo.change(record.id,value=>{value.notes='环形事件后仍可编辑';value.notesRevision++;});assert.equal((await repo.get(record.id)).events.length,1000);
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(root,'records.sqlite'));try{
  db.exec("CREATE TRIGGER abort_audio_meta BEFORE UPDATE ON record_feed_meta BEGIN SELECT RAISE(ABORT,'ACK rollback');END");const chunk=audio(source,1010);await assert.rejects(repo.ingestAudio('owner',record.id,chunk.metadata,chunk.bytes),/ACK rollback/);db.exec('DROP TRIGGER abort_audio_meta');assert.equal((await repo.get(record.id)).chunks.length,1010);
 }finally{db.close();}
 const reopened=await createRepository({root,databaseUrl:''});try{const value=await reopened.get(record.id);assert.equal(value.events.length,1000);assert.equal(value.notes,'环形事件后仍可编辑');const next=audio(source,1010);assert.equal((await reopened.ingestAudio('owner',record.id,next.metadata,next.bytes)).watermark,1010);}finally{await reopened.close();}
});

test('lightweight summaries track public transcription across cold processing and new ACKs',async t=>{
 const{repo,record,source}=await fixture(t);let chunk=audio(source,0);await repo.ingestAudio('owner',record.id,chunk.metadata,chunk.bytes);
 await repo.change(record.id,r=>{r.transcription='processing';r.chunks[0].state='done';});chunk=audio(source,1);await repo.ingestAudio('owner',record.id,chunk.metadata,chunk.bytes);
 assert.equal((await repo.listSummaries('owner'))[0].transcription,'queued');
 await repo.change(record.id,r=>{r.transcription='processing';r.sources[0].asr={state:'failed',error:'synthetic_failure'};});chunk=audio(source,2);await repo.ingestAudio('owner',record.id,chunk.metadata,chunk.bytes);
 const complete=publicRecord(await repo.get(record.id)),list=(await repo.listSummaries('owner'))[0];assert.equal(complete.transcription,'blocked');assert.equal(list.transcription,complete.transcription);
});

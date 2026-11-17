import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,readFile,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,addSource,digest} from '../packages/records/src/record.mjs';
import {searchGrams} from '../services/records/src/record-search.mjs';
import {createImportUploadQueue} from '../apps/web/src/audio/stream-import.ts';

async function fixture(t,options={}){const root=await mkdtemp(join(tmpdir(),'performance-regression-')),repo=await createRepository({root,databaseUrl:'',...options});t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});return {root,repo};}

test('completed archive preserves compressed frames and deduplicated silence',async t=>{
 const {root,repo}=await fixture(t,{compressAudio:true}),record=createRecord('owner'),source=addSource(record,{kind:'microphone'});
 const samples=[Buffer.alloc(32000),Buffer.alloc(32000),Buffer.alloc(32000,1),Buffer.alloc(32000,2)];
 const objects=[];for(const bytes of samples)objects.push((await repo.putAudio(record.id,bytes)).object);
 record.chunks=samples.map((bytes,sequence)=>({key:`${source.id}:${source.epoch}:${sequence}`,sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes),object:objects[sequence],state:'done',attempts:0,acceptedAt:Date.now()}));
 record.capture='completed';record.retainAudio=true;await repo.insert(record);
 const directory=join(root,'audio',record.id),size=async()=>{let bytes=0;for(const file of await readdir(directory))bytes+=(await readFile(join(directory,file))).length;return bytes;},before=await size();
 assert.equal((await readdir(directory)).length,3);
 await repo.archiveAudio(await repo.get(record.id));
 assert.equal(await size(),before,'packing must preserve compressed size and content deduplication');
 assert.equal((await readdir(directory)).length,2,'two unique adjacent frames share one archive; silence stays deduplicated');
 assert.ok((await readdir(directory)).includes(objects[0].split('/')[1]));
 const restarted=await createRepository({root,databaseUrl:''});try{for(let i=0;i<samples.length;i++)assert.deepEqual(await restarted.readAudio(objects[i]),samples[i]);}finally{await restarted.close();}
 await repo.cleanAudio(record.id,new Set(objects),Date.now()+1);assert.equal((await readdir(directory)).length,2);
 await repo.cleanAudio(record.id,new Set(),Infinity);assert.equal((await readdir(directory)).length,0);
});

test('archive splits continuous audio at ten minutes and preserves boundary frames',async t=>{
 const {root,repo}=await fixture(t,{compressAudio:true}),record=createRecord('owner'),source=addSource(record,{kind:'microphone'});
 let storedBytes=0;record.chunks=[];
 for(let sequence=0;sequence<1201;sequence++){
  const bytes=Buffer.alloc(32000);bytes.writeUInt32LE(sequence);
  const stored=await repo.putAudio(record.id,bytes);storedBytes+=(await readFile(join(root,'audio',stored.object))).length;
  record.chunks.push({key:`${source.id}:${source.epoch}:${sequence}`,sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes),object:stored.object,state:'done',attempts:0,acceptedAt:Date.now()});
 }
 record.capture='completed';record.retainAudio=true;await repo.insert(record);
 await repo.archiveAudio(await repo.get(record.id));
 const directory=join(root,'audio',record.id),files=await readdir(directory);assert.equal(files.length,3);
 assert.equal(files.filter(file=>file.endsWith('.pcm.pack')).length,2);
 let packedBytes=0;for(const file of files)packedBytes+=(await readFile(join(directory,file))).length;assert.equal(packedBytes,storedBytes);
 const db=new DatabaseSync(join(root,'records.sqlite'));try{assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM record_audio_archive_offsets GROUP BY archive').all().map(row=>row.count),[600,600]);}finally{db.close();}
 for(const index of [0,599,600,1199,1200]){const bytes=Buffer.alloc(32000);bytes.writeUInt32LE(index);assert.deepEqual(await repo.readAudio(record.chunks[index].object),bytes);}
});

test('repeated silent chunks already sharing one object do not create an archive',async t=>{
 const {root,repo}=await fixture(t,{compressAudio:true}),record=createRecord('owner'),source=addSource(record,{kind:'microphone'}),bytes=Buffer.alloc(32000),stored=await repo.putAudio(record.id,bytes);
 record.chunks=Array.from({length:600},(_,sequence)=>({key:`${source.id}:${source.epoch}:${sequence}`,sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes),object:stored.object,state:'done',attempts:0,acceptedAt:Date.now()}));
 record.capture='completed';record.retainAudio=true;await repo.insert(record);
 const directory=join(root,'audio',record.id),before=await readFile(join(root,'audio',stored.object));
 await repo.archiveAudio(await repo.get(record.id));
 assert.deepEqual(await readdir(directory),[stored.object.split('/')[1]]);
 assert.deepEqual(await readFile(join(root,'audio',stored.object)),before);
});

test('two-character Chinese search uses an inverted index and preserves literal matching',async t=>{
  const {root,repo}=await fixture(t),record=createRecord('owner');record.title='上海会议';record.notes='海上航线';await repo.insert(record);
  assert.ok(searchGrams('上海').includes('上海'));
  const prepare=DatabaseSync.prototype.prepare,queries=[];
  DatabaseSync.prototype.prepare=function(sql,...args){queries.push(sql);return prepare.call(this,sql,...args);};
  try{assert.equal((await repo.listSummaries('owner','all','上海'))[0].id,record.id);}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.ok(queries.some(sql=>sql.includes('record_search_cjk MATCH')));
  assert.ok(!queries.some(sql=>/AND instr\(json_extract\(p.data,'\$\.search'\)/.test(sql)));
  const db=new DatabaseSync(join(root,'records.sqlite'));t.after(()=>db.close());
  assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM record_search_cjk WHERE record_search_cjk MATCH ?').all('"上海"').map(row=>row.detail).join(' '),/VIRTUAL TABLE INDEX/);
});

test('independent training jobs participate in lane deadlines; historical workspace jobs are excluded',async t=>{
  const {repo}=await fixture(t),now=Date.now();
  await repo.insert({id:'voice',kind:'voiceprint-job',status:'waiting',retryAt:now+60000});
  await repo.insert({id:'learn',kind:'learning-training',status:'queued'});
  await repo.insert({id:'old',kind:'workspace-analysis',status:'completed',result:{huge:'x'.repeat(100000)}});
  await repo.insert({id:'new',kind:'workspace-analysis',status:'queued'});
  assert.equal(await repo.nextWorkAt('voiceprints'),now+60000);
  assert.equal(await repo.nextWorkAt('learning'),0);
  assert.deepEqual((await repo.listDueJobs('workspace-analysis')).map(job=>job.id),['new']);
});

test('ordered import upload overlaps decode with a bounded eight-chunk high water mark',async()=>{
  let release,uploads=0;const gate=new Promise(resolve=>release=resolve);
  const queue=createImportUploadQueue(async()=>{uploads++;if(uploads===1)await gate;});
  for(let i=0;i<7;i++)await queue.added();
  let waiting=true;const blocked=queue.added().then(()=>waiting=false);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(waiting,true);assert.equal(uploads,1);release();await blocked;await queue.finish();assert.equal(uploads,2);
  const failed=createImportUploadQueue(async()=>{throw new Error('upload_failed');});await failed.added();await assert.rejects(failed.finish(),/upload_failed/);
});

test('completed PCM archive keeps old digest references readable across restart and cleanup',async t=>{
  const {root,repo}=await fixture(t),record=createRecord('owner'),source=addSource(record,{kind:'microphone'});record.retainAudio=true;await repo.insert(record);
  const bytes=[Buffer.alloc(32000,1),Buffer.alloc(32000,2),Buffer.alloc(32000,3)];
  for(let sequence=0;sequence<bytes.length;sequence++)await repo.ingestAudio('owner',record.id,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes[sequence])},bytes[sequence]);
  assert.equal(await repo.archiveAudio(await repo.get(record.id)),undefined);
  assert.equal((await readdir(join(root,'audio',record.id))).some(file=>file.endsWith('.pcm.pack')),false);
  await repo.change(record.id,r=>{r.capture='completed';r.chunks.forEach(chunk=>chunk.state='done');});
  const before=await repo.get(record.id),exec=DatabaseSync.prototype.exec;let commitUnknown=true;
  DatabaseSync.prototype.exec=function(sql,...args){const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&commitUnknown&&this.prepare('SELECT object FROM record_audio_archive_offsets LIMIT 1').get()){commitUnknown=false;throw new Error('archive_commit_unknown');}return result;};
  try{await assert.rejects(repo.archiveAudio(before),/archive_commit_unknown/);}finally{DatabaseSync.prototype.exec=exec;}
  assert.deepEqual(await repo.readAudio(before.chunks[0].object),bytes[0],'uncertain COMMIT preserves referenced archive');
  await repo.archiveAudio(await repo.get(record.id));
  const files=await readdir(join(root,'audio',record.id));assert.equal(files.filter(file=>file.endsWith('.pcm.pack')).length,1);assert.equal(files.filter(file=>/^[a-f0-9]{64}$/.test(file)).length,0);
  for(let i=0;i<bytes.length;i++)assert.deepEqual(await repo.readAudio(before.chunks[i].object),bytes[i]);
  await repo.cleanAudio(record.id,new Set(before.chunks.map(chunk=>chunk.object)),Date.now()+1);assert.equal((await readdir(join(root,'audio',record.id))).length,1);
  const restarted=await createRepository({root,databaseUrl:''});try{assert.deepEqual(await restarted.readAudio(before.chunks[2].object),bytes[2]);}finally{await restarted.close();}
  assert.equal((await readFile(join(root,'audio',record.id,files[0]))).length,96000);
  await writeFile(join(root,'audio',before.chunks[0].object),bytes[0]);
  await repo.change(record.id,r=>{delete r.audioArchive;});await repo.archiveAudio(await repo.get(record.id));
  assert.equal((await readdir(join(root,'audio',record.id))).filter(file=>/^[a-f0-9]{64}$/.test(file)).length,0,'retry removes small files left after a committed archive');
  const temporary=join(root,'audio',record.id,'.tmp-archive-00000000-0000-4000-8000-000000000000.pcm.pack');
  await writeFile(temporary,bytes[0]);await utimes(temporary,new Date(0),new Date(0));
  await repo.cleanAudio(record.id,new Set(before.chunks.map(chunk=>chunk.object)),Date.now());
  assert.equal((await readdir(join(root,'audio',record.id))).some(file=>file.startsWith('.tmp-archive-')),false);
  await writeFile(temporary,bytes[0]);

  await repo.cleanAudio(record.id);assert.deepEqual(await readdir(join(root,'audio',record.id)),[]);
});

test('translation queue migration reads targets from compressed legacy headers',async t=>{
  const root=await mkdtemp(join(tmpdir(),'translation-migration-'));let repo=await createRepository({root,databaseUrl:'',compressAggregates:true});
  t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
  const record=createRecord('owner');record.notes='compress '.repeat(10000);record.translationTarget='en';record.segments=[{id:'legacy',revision:1,text:'待译内容',startMs:0,endMs:1000}];await repo.insert(record);await repo.close();
  const db=new DatabaseSync(join(root,'records.sqlite'));try{db.exec("UPDATE record_collections SET data=json_remove(data,'$.translationPending') WHERE field='segments'");}finally{db.close();}
  repo=await createRepository({root,databaseUrl:'',compressAggregates:true});
  const {processTranslation}=await import('../services/records/src/translation-worker.mjs');await processTranslation(repo,record.id,async()=> 'translated');
  assert.equal((await repo.get(record.id)).segments[0].translation,'translated');
});

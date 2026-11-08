import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';
import{createRecord}from'../packages/records/src/record.mjs';import{createRepository}from'../services/records/src/repository.mjs';

test('collection v1 is backed up before documents and task snapshots move into v2 rows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'storage-v2-')),record=createRecord('fixture');
 record.segments=[{id:'s',revision:1,text:'原文',sourceId:'text',startMs:0,endMs:1000}];
 record.jobs=[{id:'job',snapshot:record.segments,status:'completed'}];record.minutes={title:'人工纪要',edited:true,sections:[],actions:[],evidenceSnapshot:record.segments};
 const legacy=new DatabaseSync(join(root,'records.sqlite'));
 legacy.exec('CREATE TABLE aggregates(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE record_collections(record_id TEXT,field TEXT,position INTEGER,data TEXT,PRIMARY KEY(record_id,field,position))');
 const header={...record,$collections:1,$version:'legacy',$counts:{chunks:0,segments:1,events:record.events.length}};
 for(const field of ['chunks','segments','events']){delete header[field];for(let i=0;i<record[field].length;i++)legacy.prepare('INSERT INTO record_collections VALUES(?,?,?,?)').run(record.id,field,i,JSON.stringify(record[field][i]));}
 legacy.prepare('INSERT INTO aggregates VALUES(?,?)').run(record.id,JSON.stringify(header));legacy.close();
 let repo;
 try{
  repo=await createRepository({root,databaseUrl:''});assert.deepEqual((await repo.get(record.id)).minutes,record.minutes);
  const db=new DatabaseSync(join(root,'records.sqlite'));
  try{const stored=JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data);assert.equal(stored.$collections,2);assert.equal(stored.jobs,undefined);assert.equal(stored.minutes,undefined);assert.equal(db.prepare("SELECT count(*) AS n FROM record_documents WHERE record_id=? AND field='minutes'").get(record.id).n,1);
   db.exec("CREATE TRIGGER reject_document BEFORE UPDATE ON record_documents BEGIN SELECT RAISE(ABORT,'document rollback');END");await assert.rejects(repo.change(record.id,value=>{value.minutes.title='不得生效';}),/document rollback/);db.exec('DROP TRIGGER reject_document');assert.equal((await repo.get(record.id)).minutes.title,'人工纪要');
  }finally{db.close();}
  await repo.close();repo=await createRepository({root,databaseUrl:''});assert.equal((await repo.get(record.id)).jobs[0].snapshot[0].text,'原文');
  const backup=new DatabaseSync(join(root,'records.pre-collections-v2.sqlite'),{readOnly:true});try{const original=JSON.parse(backup.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data);assert.equal(original.$collections,1);assert.equal(original.minutes.edited,true);assert.equal(original.jobs.length,1);}finally{backup.close();}
 }finally{await repo?.close();await rm(root,{recursive:true,force:true});}
});

test('document deletion survives LRU eviction and a snapshot too large to cache',async()=>{
 const root=await mkdtemp(join(tmpdir(),'document-eviction-')),repo=await createRepository({root,databaseUrl:''});
 try{
  const records=Array.from({length:4},()=>createRecord('fixture'));
  for(const record of records){record.learning={enabled:false,notes:'private source text'};await repo.insert(record);}
  await repo.changeMany(records.map(record=>record.id),values=>{for(const value of values)delete value.learning;});
  const large=createRecord('fixture');large.learning={enabled:false,notes:'x'.repeat(17*1024*1024)};await repo.insert(large);
  await repo.change(large.id,value=>{delete value.learning;});
  const db=new DatabaseSync(join(root,'records.sqlite'));try{assert.equal(db.prepare("SELECT count(*) AS n FROM record_documents WHERE field='learning'").get().n,0);}finally{db.close();}
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';
import{createRepository}from'../services/records/src/repository.mjs';import{createRecord,addSource,emit,digest}from'../packages/records/src/record.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'hot-fields-'));const repo=await createRepository({root,databaseUrl:''});t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true})});return{root,repo}}
function packet(source){const bytes=Buffer.alloc(320,7);return{bytes,metadata:{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:160,sampleRate:16000,digest:digest(bytes)}}}
test('normal writes preserve absolute event positions after indexed ring pruning',async t=>{
 const{root,repo}=await fixture(t),record=createRecord('owner'),source=addSource(record,{kind:'microphone'});record.gcAt=Date.now();for(let i=0;i<1100;i++)emit(record,'fixture.event');await repo.insert(record);const p=packet(source);await repo.ingestAudio('owner',record.id,p.metadata,p.bytes);
 const db=new DatabaseSync(join(root,'records.sqlite'));try{const header=()=>JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data);assert.equal(header().$offsets.events,1);
 db.exec("CREATE TABLE event_writes(operation TEXT);CREATE TRIGGER event_insert AFTER INSERT ON record_collections WHEN NEW.field='events' BEGIN INSERT INTO event_writes VALUES('insert');END;CREATE TRIGGER event_update AFTER UPDATE ON record_collections WHEN NEW.field='events' BEGIN INSERT INTO event_writes VALUES('update');END;CREATE TRIGGER event_delete AFTER DELETE ON record_collections WHEN OLD.field='events' BEGIN INSERT INTO event_writes VALUES('delete');END");
 await repo.change(record.id,r=>{r.gcAt+=100;});assert.equal(db.prepare('SELECT count(*) n FROM event_writes').get().n,0,'unrelated maintenance must not rewrite the retained event ring');assert.equal(header().$offsets.events,1);
 await repo.change(record.id,r=>{r.title='updated';emit(r,'record.updated')});assert.equal(header().$offsets.events,2);assert.deepEqual(db.prepare('SELECT operation,count(*) n FROM event_writes GROUP BY operation ORDER BY operation').all().map(r=>({...r})),[{operation:'delete',n:1},{operation:'insert',n:1}]);assert.equal((await repo.get(record.id)).events.length,1000);
 }finally{db.close()}
});
test('indexed audio write-through retains a complete warm collection snapshot',async t=>{
 const{repo}=await fixture(t),record=createRecord('owner'),source=addSource(record,{kind:'microphone'});await repo.insert(record);await repo.get(record.id);const p=packet(source);await repo.ingestAudio('owner',record.id,p.metadata,p.bytes);
 const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql,...args){assert.doesNotMatch(sql,/SELECT field,position,data FROM record_collections WHERE record_id=\? ORDER BY field,position/,'a known indexed append must update the warm cache');return prepare.call(this,sql,...args)};
 try{const value=await repo.get(record.id);assert.equal(value.chunks.length,1);assert.equal(value.chunks[0].digest,p.metadata.digest);assert.equal(value.events.at(-1).cursor,value.cursor)}finally{DatabaseSync.prototype.prepare=prepare}
});

test('stream preview only writes its job and feed; stale fences and rollback preserve frozen inputs',async t=>{
 const {root,repo}=await fixture(t),record=createRecord('owner');
 record.gcAt=Date.now();record.jobs=[{id:'job',generation:record.generation,status:'running',fence:'current',snapshot:{frozen:'x'.repeat(100000)},preview:[{text:'old'}],runtime:{old:true}}];
 await repo.insert(record);await repo.get(record.id);
 const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql,...args){assert.doesNotMatch(sql,/SELECT field,position,data FROM record_collections/,'preview rehydrates whole record');return prepare.call(this,sql,...args)};
 try{
  await repo.changeMinutesPreview(record.id,'job','current','{"title":"first"}',{model:'test'});
  let value=await repo.get(record.id);assert.deepEqual(value.jobs[0].preview,[{kind:'title',text:'first'}]);assert.equal(value.jobs[0].snapshot.frozen.length,100000);assert.deepEqual(value.jobs[0].runtime,{model:'test'});
  const cursor=value.cursor,feed=await repo.eventsAfter(record.id,record.cursor);assert.equal(feed.events.at(-1).delta.set.jobs[0].snapshot,undefined);assert.equal(feed.events.at(-1).delta.baseCursor,record.cursor);
  await repo.changeMinutesPreview(record.id,'job','stale','{"title":"wrong"}');assert.equal((await repo.get(record.id)).cursor,cursor);
  const db=new DatabaseSync(join(root,'records.sqlite'));
  try{db.exec("CREATE TRIGGER reject_preview BEFORE UPDATE ON record_audio_stats BEGIN SELECT RAISE(ABORT,'rollback-preview');END");await assert.rejects(repo.changeMinutesPreview(record.id,'job','current','{"title":"rollback"}'),/rollback-preview/);db.exec('DROP TRIGGER reject_preview');}finally{db.close()}
  assert.equal((await repo.get(record.id)).cursor,cursor);
  await repo.changeMinutesPreview(record.id,'job','current','{"title":"second"}');value=await repo.get(record.id);assert.equal(value.jobs[0].runtime,undefined);assert.equal(value.jobs[0].preview[0].text,'second');
 }finally{DatabaseSync.prototype.prepare=prepare}
});

test('translation updates one segment with durable feed and never loads audio history',async t=>{
 const {repo}=await fixture(t),record=createRecord('owner');record.gcAt=Date.now();record.capture='recording';record.translationTarget='en';
 record.segments=Array.from({length:100},(_,i)=>({id:`s${i}`,revision:1,text:`内容 ${i}`,startMs:i*1000,endMs:(i+1)*1000,...(i===99?{}:{translationLanguage:'en',translation:'done'})}));
 await repo.insert(record);await repo.get(record.id);
 const {processTranslation}=await import('../services/records/src/translation-worker.mjs');const prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql,...args){assert.doesNotMatch(sql,/SELECT field,position,data FROM record_collections/,'translation rehydrates whole record');return prepare.call(this,sql,...args)};
 try{
  await processTranslation(repo,record.id,async text=>{assert.equal(text,'内容 99');return 'translated'},'live');
  const value=await repo.get(record.id);assert.equal(value.segments[99].translation,'translated');assert.equal(value.segments.length,100);assert.equal(value.translationLiveFromMs,undefined);assert.equal(value.workAt.translation,null);
  const feed=await repo.eventsAfter(record.id,record.cursor);assert.equal(feed.events.at(-1).delta.segments.upsert[0].id,'s99');assert.equal(feed.events.at(-1).delta.segments.upsert[0].translationFence,undefined);
  await assert.rejects(repo.changeTranslation(record.id,{claim:{kind:'segment',id:'s99'}},r=>{r.title='forbidden'}),/invalid_live_field_mutation/);assert.equal((await repo.get(record.id)).title,record.title);
 }finally{DatabaseSync.prototype.prepare=prepare}
});

test('PostgreSQL preview, translation and monotonic event positions use the same partial-write contract',{skip:!process.env.RECORD_TEST_DATABASE_URL},async t=>{
 const databaseUrl=process.env.RECORD_TEST_DATABASE_URL;assert.match(new URL(databaseUrl).pathname,/test/i);
 const root=await mkdtemp(join(tmpdir(),'hot-fields-pg-')),repo=await createRepository({root,databaseUrl});t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true})});
 const record=createRecord('hot-fields-test');record.gcAt=Date.now();record.translationTarget='en';
 record.jobs=[{id:'job',generation:record.generation,status:'running',fence:'current',snapshot:{frozen:true}}];
 record.segments=[{id:'segment',revision:1,text:'测试翻译',startMs:0,endMs:1000}];
 for(let i=0;i<1100;i++)emit(record,'fixture.event');await repo.insert(record);
 const {default:pg}=await import('pg'),query=pg.Client.prototype.query,queries=[];
 pg.Client.prototype.query=function(sql,...args){queries.push(typeof sql==='string'?sql:sql.text);return query.call(this,sql,...args)};
 try{
  await repo.changeMinutesPreview(record.id,'job','current','{"title":"preview"}',{model:'test'});
  const {processTranslation}=await import('../services/records/src/translation-worker.mjs');await processTranslation(repo,record.id,async()=> 'translated');
 }finally{pg.Client.prototype.query=query}
 assert.equal(queries.some(sql=>/SELECT field,position,data FROM record_collections/.test(sql)),false,'partial writes must not rehydrate collections');
 let value=await repo.get(record.id);assert.equal(value.jobs[0].preview[0].text,'preview');assert.deepEqual(value.jobs[0].snapshot,{frozen:true});assert.equal(value.segments[0].translation,'translated');
 const pool=new pg.Pool({connectionString:databaseUrl});try{
  const header=async()=>(await pool.query('SELECT data FROM record_aggregates WHERE id=$1',[record.id])).rows[0].data;
  const offset=(await header()).$offsets.events;assert.equal(offset,2);
  await repo.change(record.id,r=>{r.gcAt+=100});assert.equal((await header()).$offsets.events,offset);
  await repo.change(record.id,r=>emit(r,'fixture.after'));assert.equal((await header()).$offsets.events,offset+1);
  await assert.rejects(repo.changeTranslation(record.id,{claim:{kind:'segment',id:'segment'}},r=>{r.generation++}),/invalid_live_field_mutation/);
  value=await repo.get(record.id);assert.equal(value.generation,record.generation);assert.equal(value.events.length,1000);
 }finally{await pool.end()}
});

test('preview cache defers frozen-input decoding and composes repeated partial updates',async t=>{
 const {repo}=await fixture(t),record=createRecord('owner');record.jobs=[{id:'job',generation:record.generation,status:'running',fence:'f',snapshot:{frozen:'x'.repeat(100000)}}];await repo.insert(record);await repo.get(record.id);
 const parse=JSON.parse;JSON.parse=function(value,...args){assert.equal(typeof value==='string'&&value.includes('"snapshot"')&&value.length>100000,false,'stream preview decodes frozen job input');return parse(value,...args)};
 try{for(let i=0;i<3;i++)await repo.changeMinutesPreview(record.id,'job','f',`{"title":"preview ${i}"}`,{index:i});await repo.changeMinutesPreview(record.id,'job','f','{"title":"latest"}');}finally{JSON.parse=parse}
 const value=await repo.get(record.id);assert.equal(value.jobs[0].preview[0].text,'latest');assert.equal(value.jobs[0].runtime,undefined);assert.equal(value.jobs[0].snapshot.frozen.length,100000);
});

test('compressed headers and stale process cache keep audio, translation and preview together',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hot-fields-compressed-')),repo=await createRepository({root,databaseUrl:'',compressAggregates:true});let other;
 t.after(async()=>{await other?.close();await repo.close();await rm(root,{recursive:true,force:true})});
 const record=createRecord('owner'),source=addSource(record,{kind:'microphone'});record.notes='header '.repeat(10000);record.jobs=[{id:'job',generation:record.generation,status:'running',fence:'f',snapshot:{frozen:true}}];await repo.insert(record);await repo.get(record.id);
 other=await createRepository({root,databaseUrl:'',compressAggregates:true});const p=packet(source);await other.ingestAudio('owner',record.id,p.metadata,p.bytes);
 await repo.changeMinutesPreview(record.id,'job','f','{"title":"after other process"}');const value=await repo.get(record.id);assert.equal(value.chunks[0].digest,p.metadata.digest);assert.equal(value.jobs[0].preview[0].text,'after other process');assert.equal(value.notes,record.notes);
 const db=new DatabaseSync(join(root,'records.sqlite'));try{assert.equal(JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data).$payload,'deflate-v1');}finally{db.close()}
});

test('live translation selects eligible overlapping speech before applying LIMIT',async t=>{
 const {repo}=await fixture(t),record=createRecord('owner');record.capture='recording';record.translationTarget='en';record.gcAt=Date.now();record.segments=[{id:'long',revision:1,text:'long current overlap',startMs:0,endMs:10000},{id:'short',revision:1,text:'short earlier end',startMs:9000,endMs:9500}];await repo.insert(record);
 const {processTranslation}=await import('../services/records/src/translation-worker.mjs'),calls=[];await processTranslation(repo,record.id,async text=>{calls.push(text);return 'translated'},'live');assert.deepEqual(calls,['long current overlap']);assert.equal((await repo.get(record.id)).workAt['translation-live'],null);
});

test('selective lane candidates use the due index while keeping ID cursor fairness',async t=>{
 const {root,repo}=await fixture(t),db=new DatabaseSync(join(root,'records.sqlite')),now=Date.now(),expected=[];
 try{
  db.exec('BEGIN');const insert=db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)');for(let i=0;i<10000;i++){const id=`scheduled-${String(i).padStart(5,'0')}`,due=i>=9980;if(due)expected.push(id);insert.run(id,JSON.stringify({id,kind:'record',owner:'scheduler-test',nextWorkAt:0,workAt:{audio:0,'translation-live':due?0:now+3600000}}));}db.exec('COMMIT');db.exec('ANALYZE');
  const prepare=DatabaseSync.prototype.prepare,plans=[];DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);if(!sql.startsWith('SELECT data FROM aggregates WHERE'))return statement;return{all:(...params)=>{plans.push(...prepare.call(this,'EXPLAIN QUERY PLAN '+sql).all(...params));return statement.all(...params)}}};
  try{assert.deepEqual((await repo.listWork({lane:'translation-live',metadataOnly:true})).map(r=>r.id),expected);assert.deepEqual((await repo.listWork({lane:'translation-live',metadataOnly:true})).map(r=>r.id),expected);}finally{DatabaseSync.prototype.prepare=prepare}
  assert.ok(plans.some(row=>/SEARCH.*record_due_translation_live/.test(row.detail)),JSON.stringify(plans));
 }finally{db.close()}
});

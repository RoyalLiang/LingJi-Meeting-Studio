import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,emit} from '../packages/records/src/record.mjs';
import {workspaceOverview,workspaceOverviewInput} from '../packages/records/src/workspaces.mjs';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'record-foundation-')),repo=await createRepository({root,databaseUrl:'',s3:{bucket:''},compressAggregates:true});try{await run(repo,root);}finally{await repo.close();await rm(root,{recursive:true,force:true});}}
function record(){const r=createRecord('owner',{title:'设备性能评审'});r.capture='completed';r.gcAt=Date.now();r.transcriptRevision=1;r.segments=Array.from({length:3000},(_,i)=>({id:`s${i}`,revision:1,text:`合成发言 ${i} Performance`,startMs:i*1000,endMs:(i+1)*1000}));r.minutes={title:r.title,transcriptRevision:1,topics:[{title:'性能',summary:'评估延迟',evidence:[{segmentId:'s0',revision:1}]}],sections:[],decisions:[{text:'周五复核',evidence:[{segmentId:'s2999',revision:1}]}],actions:[],evidenceSnapshot:[]};return r;}

test('overview projection preserves exact public totals, citations and excerpts',()=>{
 const r=record(),projected=workspaceOverviewInput(r),now=Date.now();assert.deepEqual(workspaceOverview([projected],now),workspaceOverview([r],now));assert.ok(JSON.stringify(projected).length<JSON.stringify(r).length/2);assert.equal(projected.chunks,undefined);
});
test('scalar changes do not rewrite collections; single revisions update one row',()=>fixture(async(repo,root)=>{
 const r=record();await repo.insert(r);const db=new DatabaseSync(join(root,'records.sqlite'));try{
 db.exec('CREATE TABLE collection_writes(n INTEGER); CREATE TRIGGER count_collections AFTER UPDATE ON record_collections BEGIN INSERT INTO collection_writes VALUES(1); END');
 await repo.change(r.id,value=>{value.title='改名';emit(value,'record.updated');},{returnRecord:false});assert.equal(db.prepare('SELECT count(*) n FROM collection_writes').get().n,0);
 await repo.change(r.id,value=>{value.segments[1500].text='修订';value.segments[1500].revision++;value.transcriptRevision++;});assert.equal(db.prepare('SELECT count(*) n FROM collection_writes').get().n,1);
 }finally{db.close();}
}));
test('legacy whole records migrate on write and rolled-back mutations never poison cache',()=>fixture(async(repo,root)=>{
 const r=record(),db=new DatabaseSync(join(root,'records.sqlite'));try{
 db.prepare('INSERT INTO aggregates(id,data) VALUES(?,?)').run(r.id,JSON.stringify(r));
 await repo.change(r.id,value=>{value.title='已迁移';});assert.equal((await repo.get(r.id)).segments.length,3000);
 await assert.rejects(repo.change(r.id,value=>{value.segments.pop();value.chunks.push({key:'invalid'});throw new Error('rollback');}),/rollback/);
 assert.equal((await repo.get(r.id)).segments.length,3000);assert.equal((await repo.get(r.id)).chunks.length,0);
 const second=await createRepository({root,databaseUrl:'',s3:{bucket:''}});try{await second.change(r.id,value=>{value.segments[0].text='来自另一个进程';});assert.equal((await repo.get(r.id)).segments[0].text,'来自另一个进程');}finally{await second.close();}
 const copies=await repo.get(r.id);copies.segments[0].text='外部修改';assert.equal((await repo.get(r.id)).segments[0].text,'来自另一个进程');
 }finally{db.close();}
}));
test('overview and quota use projections without decoding archive payloads',()=>fixture(async repo=>{
 const r=record();await repo.insert(r);const get=repo.get;repo.get=()=>assert.fail('projection should not read aggregate');
 try{assert.equal((await repo.listRecordHeaders('owner')).length,1);assert.equal((await repo.listOverviewInputs('owner')).length,1);assert.equal((await repo.listOverviewInputs('other')).length,0);}finally{repo.get=get;}
}));
test('trigram search preserves literal CJK, short, punctuation and owner/scope matching',()=>fixture(async repo=>{
 const r=record();r.title='性能评审 a"b alpha_beta';await repo.insert(r);
 for(const query of ['性能评审','性能','performance','a"b','alpha_beta'])assert.equal((await repo.listSummaries('owner','all',query)).length,1,query);
 assert.equal((await repo.listSummaries('other','all','性能评审')).length,0);assert.equal((await repo.listSummaries('owner','missing','performance')).length,0);
 await repo.change(r.id,value=>{value.deleted=true;emit(value,'record.deleted');});assert.equal((await repo.listSummaries('owner','all','performance')).length,0);
}));

test('failure after collection writes rolls back rows, FTS and cached version together',()=>fixture(async(repo,root)=>{
 const r=record();await repo.insert(r);const db=new DatabaseSync(join(root,'records.sqlite'));try{
 db.exec("CREATE TRIGGER reject_projection BEFORE UPDATE ON record_feed_meta BEGIN SELECT RAISE(ABORT,'projection blocked'); END");
 await assert.rejects(repo.change(r.id,value=>{value.segments.pop();value.title='rollback marker';emit(value,'record.updated');}),/projection blocked/);
 db.exec('DROP TRIGGER reject_projection');const restored=await repo.get(r.id);assert.equal(restored.segments.length,3000);assert.equal(restored.title,r.title);assert.equal((await repo.listSummaries('owner','all','rollback marker')).length,0);
 await repo.change(r.id,value=>{value.segments[2999].text='真实修订';});assert.equal((await repo.get(r.id)).segments[2999].text,'真实修订');
 }finally{db.close();}
}));

test('same-count collection update between header and hydration returns one committed snapshot',()=>fixture(async(writer,root)=>{
 const r=record();await writer.insert(r);const reader=await createRepository({root,databaseUrl:'',s3:{bucket:''}}),prepare=DatabaseSync.prototype.prepare;let interleaved=false,change;
 DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);if(sql==='SELECT data FROM aggregates WHERE id=?')return new Proxy(statement,{get(target,key){if(key==='get')return(...params)=>{const row=target.get(...params);if(!interleaved){interleaved=true;change=writer.change(r.id,value=>{value.transcriptRevision=2;value.segments[0].revision=2;value.segments[0].text='new';});}return row;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});return statement;};
 try{const value=await reader.get(r.id);await change;assert.equal(value.transcriptRevision,value.segments[0].revision);assert.equal(value.segments[0].text,'new');}finally{DatabaseSync.prototype.prepare=prepare;await reader.close();}
}));
test('failed insert can retry without a rolled-back collection cache skipping rows',()=>fixture(async(repo,root)=>{
 const r=record(),db=new DatabaseSync(join(root,'records.sqlite'));try{
 db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON record_feed_meta BEGIN SELECT RAISE(ABORT,'blocked insert'); END");await assert.rejects(repo.insert(r));db.exec('DROP TRIGGER reject_insert');await repo.insert(r);
 const fresh=await createRepository({root,databaseUrl:'',s3:{bucket:''}});try{assert.equal((await fresh.get(r.id)).segments.length,3000);}finally{await fresh.close();}
 }finally{db.close();}
}));
test('read-only learning snapshots hydrate normalized transcript and audio metadata',()=>fixture(async(repo,root)=>{
 const {readSnapshot}=await import('../scripts/alpha-learning/intake.mjs'),r=record();r.chunks=[{key:'mic:e:0',sourceId:'mic',epoch:'e',sequence:0,sampleCount:16000,sampleOffset:0,object:'synthetic.pcm'}];await repo.insert(r);
 const [snapshot]=readSnapshot(root);assert.equal(snapshot.segments.length,3000);assert.equal(snapshot.segments[0].text,r.segments[0].text);assert.equal(snapshot.chunks.length,1);
}));

test('legacy schema gets one immutable backup before normalized writes begin',async()=>{
 const root=await mkdtemp(join(tmpdir(),'record-migration-backup-')),r=record();let repo;
 try{
  const db=new DatabaseSync(join(root,'records.sqlite'));db.exec('CREATE TABLE aggregates(id TEXT PRIMARY KEY,data TEXT)');db.prepare('INSERT INTO aggregates VALUES(?,?)').run(r.id,JSON.stringify(r));db.close();
  repo=await createRepository({root,databaseUrl:'',s3:{bucket:''}});await repo.change(r.id,value=>{value.title='迁移后';});
  const copy=new DatabaseSync(join(root,'records.pre-collections-v1.sqlite'),{readOnly:true});try{const original=JSON.parse(copy.prepare('SELECT data FROM aggregates WHERE id=?').get(r.id).data);assert.equal(original.title,r.title);assert.equal(original.segments.length,3000);}finally{copy.close();}
  assert.equal((await repo.get(r.id)).title,'迁移后');
 }finally{await repo?.close();await rm(root,{recursive:true,force:true});}
});


test('legacy overview projections backfill minutes usage once and preserve it with the live audio clock',()=>fixture(async(repo,root)=>{
 const r=record();r.usage.minutesMeter={requests:1,reportedRequests:1,totalTokens:12345,totalTokensRequests:1};await repo.insert(r);
 const db=new DatabaseSync(join(root,'records.sqlite'));
 try{
  db.prepare("UPDATE record_list_projection SET data=json_remove(data,'$.overview.usage.minutesMeter') WHERE id=?").run(r.id);
  assert.equal((await repo.listOverviewInputs('owner'))[0].usage.minutesMeter.totalTokens,12345);
  const get=repo.get;repo.get=()=>assert.fail('warm overview must use the upgraded projection');
  try{const input=(await repo.listOverviewInputs('owner'))[0];assert.equal(input.usage.minutesMeter.totalTokens,12345);assert.equal(workspaceOverview([input]).periods[0].minutesTokens,12345);}finally{repo.get=get;}
 }finally{db.close();}
}));

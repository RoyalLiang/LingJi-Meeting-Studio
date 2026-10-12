import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord,emit,publicRecord} from '../packages/records/src/record.mjs';
import {DatabaseSync} from 'node:sqlite';
const js=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/record-subscription.ts',import.meta.url),'utf8')).replaceAll('export function','function')+'\nexports.apply=applyRecordDelta;';
const exported={};vm.runInNewContext(js,{exports:exported});
test('transactional projection deltas, rollback, lightweight listing and derived feed rebuild',async()=>{
  const root=await mkdtemp(join(tmpdir(),'record-projection-'));let repo=await createRepository({root});
  try{
    const record=createRecord('owner',{title:'Projection',language:'zh'});await repo.insert(record);
    const original=publicRecord(await repo.get(record.id));
    await repo.change(record.id,r=>{r.segments.push({id:'segment-1',text:'SECRET_TRANSCRIPT',revision:1,startMs:0,endMs:10});r.transcriptRevision++;emit(r,'transcript.updated',{});});
    const feed=await repo.eventsAfter(record.id,original.cursor);assert.equal(feed.events.length,1);
    const delta=feed.events[0].delta;assert.equal(delta.segments.upsert.length,1);assert.ok(!delta.set.sources);
    const applied=exported.apply(original,delta);assert.deepEqual(JSON.parse(JSON.stringify(applied)),publicRecord(await repo.get(record.id)));
    assert.equal(exported.apply(applied,delta),applied);assert.equal(exported.apply({...original,cursor:'999'},delta).cursor,'999');
    assert.equal(exported.apply({...original,cursor:'0'},delta),null);
    await assert.rejects(repo.change(record.id,r=>{r.title='WRONG';emit(r,'changed',{});throw new Error('rollback');}));
    const summary=await repo.listSummaries('owner','all','secret_transcript');assert.equal(summary[0].title,'Projection');assert.ok(!JSON.stringify(summary).includes('SECRET_TRANSCRIPT'));assert.equal((await repo.listSummaries('other')).length,0);
    assert.equal((await repo.eventsAfter(record.id,original.cursor)).cursor,feed.cursor);
    await repo.close();const db=new DatabaseSync(join(root,'records.sqlite'));db.exec('DELETE FROM record_feed_meta; DELETE FROM record_feed_events; DELETE FROM record_list_projection');db.close();
    repo=await createRepository({root});assert.equal((await repo.eventsAfter(record.id,'0')).events.length,2);assert.equal((await repo.listSummaries('owner')).length,1);
    await repo.change(record.id,r=>{r.deleted=true;emit(r,'record.deleted',{});});assert.equal((await repo.eventsAfter(record.id,'0')).deleted,true);assert.equal((await repo.listSummaries('owner')).length,0);
  }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});

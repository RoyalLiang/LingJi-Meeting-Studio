import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRepository} from '../services/records/src/repository.mjs';
import {createRecord} from '../packages/records/src/record.mjs';
const databaseUrl=process.env.RECORD_TEST_DATABASE_URL;
test('Postgres natural questions rank across 100 meetings, preserve owner scope and invalidate reviewed evidence',{skip:!databaseUrl},async t=>{
 assert.match(new URL(databaseUrl).pathname,/test/i);
 const root=await mkdtemp(join(tmpdir(),'knowledge-question-pg-')),repo=await createRepository({root,databaseUrl}),owner='knowledge-question-pg-'+randomUUID(),ids=[];
 t.after(async()=>{
  const {Pool}=await import('pg'),sql=new Pool({connectionString:databaseUrl});
  for(const table of ['record_feed_events','record_collections','record_documents','record_collection_backups','record_audio_stats','record_audio_ranges','record_knowledge','record_knowledge_state'])await sql.query(`DELETE FROM ${table} WHERE record_id=ANY($1::TEXT[])`,[ids]);
  for(const table of ['record_aggregates','record_feed_meta','record_list_projection'])await sql.query(`DELETE FROM ${table} WHERE id=ANY($1::TEXT[])`,[ids]);
  await sql.end();await repo.close();await rm(root,{recursive:true,force:true});
 });
 let target;
 for(let i=0;i<100;i++){
  const record=createRecord(owner,{title:'PG会议 '+i}),text=i===0?'Zipformer由小陈负责，周五发布。':'负责日常事项跟进 '+i;
  ids.push(record.id);Object.assign(record,{createdAt:new Date(Date.now()-86400000+i*1000).toISOString(),capture:'completed',transcriptRevision:1,minutesRevision:1,segments:[{id:'s',revision:1,text,startMs:0,endMs:1000}],minutes:{revision:1,transcriptRevision:1,decisions:[{text,evidence:[{segmentId:'s',revision:1}]}]}});await repo.insert(record);if(i===0)target=record;
 }
 const found=await repo.retrieveKnowledge(owner,'all','Zipformer由谁负责？');assert.equal(found.coverage.indexedMeetings,100);assert.equal(found.entries[0].recordId,target.id);assert.equal(await repo.validateKnowledge(owner,found),true);
 assert.equal((await repo.retrieveKnowledge('other-'+owner,'all','Zipformer由谁负责？')).entries.length,0);
 assert.equal((await repo.retrieveKnowledge(owner,'all','Zipformer"\\由谁负责？')).entries[0].recordId,target.id);
 await repo.reviewKnowledge(owner,'all',found.entries[0].id,{status:'confirmed',revision:found.entries[0].reviewRevision});await assert.rejects(repo.validateKnowledge(owner,found),/agent_knowledge_changed/);
});

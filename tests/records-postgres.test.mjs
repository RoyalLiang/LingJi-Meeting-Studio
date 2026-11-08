import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecord,addSource,digest,publicRecord } from '../packages/records/src/record.mjs';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
const databaseUrl = process.env.RECORD_TEST_DATABASE_URL;
test('Postgres notifications commit, suppress rollback, reconnect and index retained knowledge', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Use a dedicated test database');
  const root = await mkdtemp(join(tmpdir(), 'evolution-postgres-'));
  const repo = await createRepository({root,databaseUrl});
  const {Pool} = await import('pg'), sql = new Pool({connectionString:databaseUrl});
  const record = createRecord('evolution-postgres-test-only');
  const events = new EventEmitter(), changes = [];
  const unsubscribe = repo.subscribeChanges(ids => {changes.push(ids);events.emit('change',ids);},{all:true});
  t.after(async()=>{
    unsubscribe(); await sql.query('DELETE FROM record_knowledge WHERE record_id=$1',[record.id]);
    await sql.query('DELETE FROM record_knowledge_state WHERE record_id=$1',[record.id]);
    await sql.query('DELETE FROM record_aggregates WHERE id=$1',[record.id]);
    await sql.query('DELETE FROM record_collections WHERE record_id=$1',[record.id]);await sql.query('DELETE FROM record_documents WHERE record_id=$1',[record.id]);await sql.query('DELETE FROM record_collection_backups WHERE record_id=$1',[record.id]);
    await repo.close(); await sql.end(); await rm(root,{recursive:true,force:true});
  });
  const waitForChange = async predicate => {
    const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),5000);
    try { while (!changes.some(predicate)) await once(events,'change',{signal:controller.signal}); }
    finally {clearTimeout(timer);}
  };
  await repo.insert(record); await waitForChange(ids=>ids.includes(record.id)); changes.length=0;
  const client = await sql.connect();
  try {await client.query('BEGIN');await client.query("UPDATE record_aggregates SET data=jsonb_set(data,'{title}','\"rollback\"') WHERE id=$1",[record.id]);await client.query('ROLLBACK');}
  finally {client.release();}
  await new Promise(resolve=>setTimeout(resolve,100)); assert.deepEqual(changes,[]);
  await repo.change(record.id,()=>{}); await new Promise(resolve=>setTimeout(resolve,100)); assert.deepEqual(changes,[]);
  const listeners = (await sql.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN lingji_record_changes_v1'")).rows;
  assert.ok(listeners.length>0);
  for(const {pid} of listeners)await sql.query('SELECT pg_terminate_backend($1)',[pid]);
  await waitForChange(ids=>ids.length===0); changes.length=0;
  await repo.change(record.id,value=>{
    value.capture='completed';value.transcriptRevision=1;value.minutesRevision=1;
    value.segments=[{id:'pg-segment',revision:1,text:'周五发布',sourceId:'pg-source',startMs:0,endMs:1000}];
    value.minutes={revision:1,transcriptRevision:1,topics:[{id:'release',title:'发布计划'}],decisions:[{text:'周五发布',topicId:'release',evidence:[{segmentId:'pg-segment',revision:1}]}],actions:[],sections:[]};
  });
  await waitForChange(ids=>ids.includes(record.id));
  const stored=(await sql.query('SELECT data FROM record_aggregates WHERE id=$1',[record.id])).rows[0].data;
  assert.equal(stored.$collections,2);assert.equal(stored.segments,undefined);assert.equal(stored.minutes,undefined);
  assert.equal((await repo.get(record.id)).segments[0].text,'周五发布');
  assert.equal((await repo.list('record')).find(value=>value.id===record.id).minutes.decisions[0].text,'周五发布');
  const page=await repo.listKnowledge(record.owner,'all',{query:'周五发布'});
  assert.equal(page.total,1);assert.deepEqual(page.entries[0].highlights,[{start:0,end:4}]);
  const reviewed=await repo.reviewKnowledge(record.owner,'all',page.entries[0].id,{status:'confirmed',revision:0});assert.equal(reviewed.status,'confirmed');
  await assert.rejects(repo.reviewKnowledge('other','all',reviewed.id,{status:'confirmed',revision:1}),{code:'knowledge_not_found'});
  await repo.change(record.id,value=>{value.segments[0].revision++;value.transcriptRevision++;});
  assert.equal((await repo.listKnowledge(record.owner,'all')).total,0);
  assert.equal((await repo.listKnowledge(record.owner,'all',{status:'retracted'})).total,1);
  const index=(await sql.query("SELECT indexdef FROM pg_indexes WHERE indexname='knowledge_grams'")).rows[0];assert.match(index.indexdef,/USING gin/i);
});
test('Postgres row locking and restart durability', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Use a dedicated test database');
  const root = await mkdtemp(join(tmpdir(), 'tts-postgres-')); let repo = await createRepository({ root, databaseUrl });
  const record = createRecord('integration-test-only');
  try {
    await repo.insert(record);
    await Promise.all(Array.from({ length: 10 }, () => repo.change(record.id, r => { r.notesRevision++; })));
    await repo.close(); repo = await createRepository({ root, databaseUrl });
    assert.equal((await repo.get(record.id)).notesRevision, 10);
  } finally {
    const { Pool } = await import('pg'); const cleanup = new Pool({ connectionString: databaseUrl });
    await cleanup.query("DELETE FROM record_aggregates WHERE id=$1 AND data->>'owner'='integration-test-only'", [record.id]);
    await cleanup.query('DELETE FROM record_collections WHERE record_id=$1',[record.id]);await cleanup.query('DELETE FROM record_documents WHERE record_id=$1',[record.id]);await cleanup.query('DELETE FROM record_collection_backups WHERE record_id=$1',[record.id]);
    await cleanup.end(); await repo.close(); await rm(root, { recursive: true });
  }
});

test('Postgres indexed audio serializes concurrent ACKs with cold edits and preserves feed snapshots', {skip:!databaseUrl}, async t=>{
  assert.match(new URL(databaseUrl).pathname,/test/i);
  const root=await mkdtemp(join(tmpdir(),'indexed-pg-')),repo=await createRepository({root,databaseUrl}),{Pool}=await import('pg'),sql=new Pool({connectionString:databaseUrl});
  const record=createRecord('indexed-pg-test-only'),source=addSource(record,{kind:'microphone'});
  t.after(async()=>{for(const table of ['record_feed_events','record_collections','record_documents','record_collection_backups','record_audio_stats','record_audio_ranges','record_knowledge','record_knowledge_state'])await sql.query(`DELETE FROM ${table} WHERE record_id=$1`,[record.id]);for(const table of ['record_aggregates','record_feed_meta','record_list_projection'])await sql.query(`DELETE FROM ${table} WHERE id=$1`,[record.id]);await repo.close();await sql.end();await rm(root,{recursive:true,force:true});});
  await repo.insert(record);const before=publicRecord(record);
  const chunk=sequence=>{const bytes=Buffer.alloc(32000,sequence+1);return{bytes,metadata:{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*16000,sampleCount:16000,sampleRate:16000,digest:digest(bytes)}};};
  await Promise.all([1,0,2,1].map(sequence=>{const value=chunk(sequence);return repo.ingestAudio(record.owner,record.id,value.metadata,value.bytes);}));
  const result=await repo.get(record.id);assert.equal(result.chunks.length,3);assert.equal(result.sources[0].watermark,2);assert.equal(result.usage.samples,48000);
  let value=before;for(const event of (await repo.eventsAfter(record.id,before.cursor)).events){assert.equal(event.delta.baseCursor,value.cursor);value={...value,...event.delta.set};}assert.deepEqual(value,publicRecord(result));
  assert.equal((await repo.listSummaries(record.owner))[0].seconds,3);assert.equal((await repo.listOverviewInputs(record.owner))[0].usage.samples,48000);
  const fourth=chunk(3);await Promise.all([repo.ingestAudio(record.owner,record.id,fourth.metadata,fourth.bytes),repo.change(record.id,r=>{r.notes='并发保留';r.notesRevision++;})]);
  const edited=await repo.get(record.id);assert.equal(edited.chunks.length,4);assert.equal(edited.notes,'并发保留');assert.equal(edited.sources[0].watermark,3);
});

test('Postgres retained record search uses GIN candidates, literal filtering and original-case safe excerpts', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl).pathname, /test/i, 'Use a dedicated test database');
  const root = await mkdtemp(join(tmpdir(), 'record-search-pg-')), repo = await createRepository({ root, databaseUrl });
  const { Pool } = await import('pg'), sql = new Pool({ connectionString: databaseUrl }), owner = 'search-' + crypto.randomUUID();
  const records = [createRecord(owner), createRecord(owner), createRecord(owner + '-other')];
  for (const [index, record] of records.entries()) {
    record.title = index ? 'Other meeting' : 'AlphaSearch 复盘'; record.segments = [{ id: crypto.randomUUID(), revision: 1, sourceId: 'text-import', text: 'Quote"slash\\ 性能卡点', speaker: '', startMs: 0, endMs: 0, edited: false }];
  }
  records[1].workspaceId = 'separate';
  t.after(async () => {
    const ids = records.map(record => record.id);
    for (const table of ['record_feed_events','record_collections','record_documents','record_collection_backups','record_audio_stats','record_audio_ranges','record_knowledge','record_knowledge_state']) await sql.query(`DELETE FROM ${table} WHERE record_id=ANY($1::TEXT[])`, [ids]);
    for (const table of ['record_aggregates','record_feed_meta','record_list_projection']) await sql.query(`DELETE FROM ${table} WHERE id=ANY($1::TEXT[])`, [ids]);
    await repo.close(); await sql.end(); await rm(root, { recursive: true, force: true });
  });
  records[0].segments[0].text += ' ' + 'İ'.repeat(100) + 'Target ' + 'x'.repeat(200);
  for (const record of records) await repo.insert(record);
  for (const query of ['alphasearch','性能卡点','Quote"slash\\']) {
    const result = await repo.listSummaries(owner, 'inbox', query); assert.equal(result.length, 1); assert.equal(result[0].id, records[0].id); assert.ok(result[0].search.highlights.length);
  }
  assert.match((await repo.listSummaries(owner, 'inbox', 'alphasearch'))[0].search.snippet, /AlphaSearch/);
  for (const query of ['target','x'.repeat(200)]) { const result = (await repo.listSummaries(owner,'inbox',query))[0]; const range = result.search.highlights[0]; assert.ok(range); assert.equal(result.search.snippet.slice(range.start,range.end).toLowerCase(),query); }
  assert.equal((await repo.listSummaries(owner, 'separate', '性能卡点')).length, 1);
  const client = await sql.connect();
  try {
    await client.query('SET enable_seqscan=off');
    const plan = await client.query("EXPLAIN (FORMAT JSON) SELECT id FROM record_list_projection WHERE grams @> ARRAY['性能卡','能卡点']::TEXT[]");
    assert.match(JSON.stringify(plan.rows), /record_list_search_grams/);
  } finally { await client.query('RESET enable_seqscan'); client.release(); }
  await repo.change(records[0].id, record => { record.segments[0].text = '完成修正'; record.transcriptRevision++; });
  assert.equal((await repo.listSummaries(owner, 'inbox', '性能卡点')).length, 0);
});

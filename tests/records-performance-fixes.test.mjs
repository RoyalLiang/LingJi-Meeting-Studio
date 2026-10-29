import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRepository} from '../services/records/src/repository.mjs';
import {runCycle} from '../services/records/src/worker.mjs';
import {processWorkspaceAnalysis} from '../services/records/src/workspace-worker.mjs';
import {createRecord,addSource,acknowledge} from '../packages/records/src/record.mjs';
import {inputHash,requestWorkspaceAnalysis} from '../packages/records/src/workspaces.mjs';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'meeting-performance-'));
  const repo=await createRepository({root,databaseUrl:'',s3:{bucket:''},compressAggregates:true});
  try { await run(repo); } finally { await repo.close(); await rm(root,{recursive:true,force:true}); }
}
function history(index=0) {
  const record=createRecord('synthetic-owner',{title:`Synthetic history ${index}`});
  record.capture='completed';record.gcAt=Date.now();record.translationTarget='en';
  record.segments=[{id:`segment-${index}`,revision:1,text:'Synthetic statement',startMs:0,endMs:1000}];
  record.transcriptRevision=1;record.insights={transcriptRevision:1};
  return record;
}

test('due work rotates beyond 100 unavailable translations and keeps lane cursors independent',()=>fixture(async repo=>{
  for(let i=0;i<201;i++){const r=history(i);r.id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;await repo.insert(r);}
  const first=await repo.listWork({lane:'audio'});
  assert.equal(first.length,100);
  assert.deepEqual((await repo.listWork({lane:'minutes'})).map(r=>r.id),first.map(r=>r.id));
  const second=await repo.listWork({lane:'audio'}),third=await repo.listWork({lane:'audio'});
  assert.equal(new Set([...first,...second,...third].map(r=>r.id)).size,201);
  assert.equal(second.length,100);assert.equal(third.length,100);
}));

test('new durable audio is transcribed while 100 unrelated tasks remain due',()=>fixture(async repo=>{
  for(let i=0;i<100;i++){const r=history(i);r.id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;await repo.insert(r);}
  const target=createRecord('synthetic-target',{title:'Synthetic fresh recording'});
  target.id='ffffffff-ffff-4fff-8fff-ffffffffffff';target.gcAt=Date.now();
  const source=addSource(target,{kind:'microphone'});
  const object=await repo.putAudio(target.id,Buffer.alloc(32000));
  acknowledge(target,{sourceId:source.id,sessionId:source.sessionId,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:16000,sampleRate:16000,...object});
  await repo.insert(target);let calls=0;
  for(let i=0;i<3;i++)await runCycle(repo,{transcribe:async()=>{calls++;return 'Synthetic transcription';}},{lane:'audio'});
  assert.equal(calls,1);assert.equal((await repo.get(target.id)).chunks[0].state,'done');
  assert.equal((await repo.get('00000000-0000-4000-8000-000000000000')).translationTarget,'en');
}));

test('scheduling preserves unresolved expired predecessors and scans long histories linearly',()=>fixture(async repo=>{
  const record=createRecord('synthetic-owner',{title:'Synthetic ordered source'});record.gcAt=Date.now();
  const source=addSource(record,{kind:'microphone'});source.watermark=1;
  record.chunks=[{sourceId:source.id,sequence:1,state:'pending',attempts:0},{sourceId:source.id,sequence:0,state:'pending',expired:true,attempts:5}];
  await repo.insert(record);assert.ok((await repo.get(record.id)).nextWorkAt>Date.now());
  await repo.change(record.id,r=>{r.chunks[1].state='done';});
  assert.ok((await repo.get(record.id)).nextWorkAt<=Date.now());
  const large=createRecord('synthetic-owner',{title:'Synthetic backlog'});large.gcAt=Date.now();
  const lane=addSource(large,{kind:'microphone'});lane.watermark=1999;let reads=0;
  large.chunks=Array.from({length:2000},(_,index)=>({sourceId:lane.id,get sequence(){reads++;return index;},state:index<1000?'done':'pending',attempts:0,sampleCount:16000,acceptedAt:Date.now()}));
  await repo.insert(large);assert.ok(reads<120000,`expected linear sequence access, got ${reads}`);
}));

test('completed workspace analyses use lightweight inputs and still invalidate on change',()=>fixture(async repo=>{
  const record=history();delete record.translationTarget;await repo.insert(record);
  const job=requestWorkspaceAnalysis(record.owner,'all',[record]);job.status='completed';
  await repo.insert(job);let fullLists=0,gets=0;
  const list=repo.list.bind(repo),get=repo.get.bind(repo);
  repo.list=async(kind='record')=>{if(kind==='record')fullLists++;return list(kind);};
  repo.get=async id=>{gets++;return get(id);};
  for(let i=0;i<3;i++)await processWorkspaceAnalysis(repo,{});
  assert.equal(fullLists,0);assert.equal(gets,0);assert.equal((await get(job.id)).status,'completed');
  await repo.change(record.id,r=>{r.title='Changed without advancing the cursor';});
  await processWorkspaceAnalysis(repo,{});
  assert.equal((await get(job.id)).status,'stale');assert.equal(fullLists,0);
}));

test('legacy analysis metadata loads each aggregate once and accepts same-cursor upgrades',()=>fixture(async repo=>{
  const record=history();delete record.translationTarget;delete record.notesRevision;await repo.insert(record);
  const db=new DatabaseSync(join(repo.root,'records.sqlite'));
  try {
    db.prepare("UPDATE record_feed_meta SET data=json_remove(data,'$.analysisInput') WHERE id=?").run(record.id);
    let gets=0;const get=repo.get.bind(repo);repo.get=async id=>{gets++;return get(id);};
    const inputs=await repo.listAnalysisInputs();assert.equal(gets,1);assert.equal(inputHash(inputs),inputHash([record]));
    inputs[0].title='Caller mutation must not change cache';
    assert.equal((await repo.listAnalysisInputs())[0].title,record.title);assert.equal(gets,1);
    await repo.change(record.id,r=>{r.notesRevision=1;});
    const updated=await repo.listAnalysisInputs();assert.notEqual(inputHash(updated),inputHash([record]));assert.equal(gets,1);
    db.prepare("UPDATE record_feed_meta SET data=json_set(data,'$.deleted',1) WHERE id=?").run(record.id);
    assert.deepEqual(await repo.listAnalysisInputs(),[]);
    db.prepare('DELETE FROM record_feed_meta WHERE id=?').run(record.id);
    assert.deepEqual(await repo.listAnalysisInputs(),[]);
  } finally { db.close(); }
}));


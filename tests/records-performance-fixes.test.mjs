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
  const first=await repo.listWork({lane:'translation'});
  assert.equal(first.length,100);
  assert.deepEqual((await repo.listWork({lane:'all'})).map(r=>r.id),first.map(r=>r.id));
  const second=await repo.listWork({lane:'translation'}),third=await repo.listWork({lane:'translation'});
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


test('a due learning review does not decode archived meetings in unrelated worker lanes',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.learning={enabled:true,status:'queued',attempts:0,revision:r.transcriptRevision};r.segments[0].text='Synthetic large archive '.repeat(10000);await repo.insert(r);
 const parse=JSON.parse;let archiveDecodes=0;JSON.parse=function(value,...args){if(typeof value==='string'&&value.includes('Synthetic large archive '))archiveDecodes++;return parse(value,...args);};
 try{for(const lane of ['audio','minutes','intents','translation','translation-live','translation-preview','realtime'])assert.equal((await repo.listWork({lane})).length,0,lane);assert.equal(archiveDecodes,0);assert.equal((await repo.listWork({lane:'learning'})).length,1);}
 finally{JSON.parse=parse;}
}));

test('legacy compressed work scheduling backfills headers once without rewriting archive payloads',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.learning={enabled:true,status:'queued',attempts:0,revision:r.transcriptRevision};r.segments[0].text='Legacy archive marker '.repeat(10000);await repo.insert(r);
 const db=new DatabaseSync(join(repo.root,'records.sqlite'));
 try{
 const payload=db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(r.id).payload;
 db.prepare("UPDATE aggregates SET data=json_remove(data,'$.workAt') WHERE id=?").run(r.id);
 assert.equal((await repo.listWork({lane:'audio'})).length,0);assert.ok(JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(r.id).data).workAt);
 assert.deepEqual(db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(r.id).payload,payload);
 const parse=JSON.parse;let decoded=0;JSON.parse=function(value,...args){if(typeof value==='string'&&value.includes('Legacy archive marker '))decoded++;return parse(value,...args);};
 try{assert.equal((await repo.listWork({lane:'minutes'})).length,0);assert.equal(decoded,0);}finally{JSON.parse=parse;}
 await repo.change(r.id,value=>{value.jobs.push({id:'new-job',status:'queued'});});assert.equal((await repo.listWork({lane:'minutes'})).length,1);
 }finally{db.close();}
}));

test('a transaction snapshot parsed from immutable JSON does not clone the entire meeting a second time',()=>fixture(async repo=>{
 const r=history();r.minutes={summary:'Unrelated archive clone marker '.repeat(10000),revision:1};await repo.insert(r);
 const clone=globalThis.structuredClone;let copies=0;globalThis.structuredClone=function(value,...args){if(value?.minutes?.summary?.includes('Unrelated archive clone marker '))copies++;return clone(value,...args);};
 try{await repo.change(r.id,value=>{value.title='Updated title';return true;});assert.equal(copies,0);assert.equal((await repo.get(r.id)).title,'Updated title');}
 finally{globalThis.structuredClone=clone;}
}));

test('workers may skip unused aggregate copies while explicit transaction results stay isolated',()=>fixture(async repo=>{
 const r=history();await repo.insert(r);let copies=0;const clone=globalThis.structuredClone;globalThis.structuredClone=function(value,...args){if(value?.kind==='record')copies++;return clone(value,...args);};
 try{
 assert.equal(await repo.change(r.id,()=>{},{returnRecord:false}),undefined);
 assert.equal(await repo.change(r.id,value=>{value.title='saved';},{returnRecord:false}),undefined);
 assert.equal(copies,0);const explicit=await repo.change(r.id,value=>value.segments,{returnRecord:false});explicit[0].text='caller edit';assert.equal((await repo.get(r.id)).segments[0].text,'Synthetic statement');
 assert.equal((await repo.change(r.id,()=>{})).title,'saved');assert.equal(copies,1,'default caller contract still returns an isolated aggregate');
 }finally{globalThis.structuredClone=clone;}
}));

test('exhausted audio is not repeatedly scheduled as purge-ready while manual retry remains possible',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.retainAudio=false;r.audioPurged=false;r.capture='completed';r.gcAt=Date.now();r.insights={transcriptRevision:r.transcriptRevision};
 r.sources=[{id:'mic',kind:'microphone',epoch:'e',watermark:0,lastSequence:0,asr:{state:'failed',attempts:5}}];
 r.chunks=[{key:'mic:e:0',sourceId:'mic',epoch:'e',sequence:0,state:'failed',attempts:5,acceptedAt:Date.now(),object:r.id+'/failed.pcm'}];
 await repo.insert(r);assert.equal((await repo.listWork({lane:'audio'})).length,0,'exhausted transcription must wait for retry or retention rather than spin');
 assert.equal((await repo.get(r.id)).chunks[0].expired,undefined);
 await repo.change(r.id,value=>{value.chunks[0].attempts=0;value.chunks[0].state='queued';value.sources[0].asr={state:'queued',attempts:0};});
 assert.equal((await repo.listWork({lane:'audio'})).length,1,'manual retry wakes immediately');
}));

test('stale compressed scheduling headers repair once without rewriting archived content',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.retainAudio=true;r.gcAt=Date.now();r.insights={transcriptRevision:r.transcriptRevision};r.segments[0].text='Stale fixture archive '.repeat(10000);await repo.insert(r);
 const db=new DatabaseSync(join(repo.root,'records.sqlite'));
 try{
  const payload=db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(r.id).payload;
  db.prepare("UPDATE aggregates SET data=json_set(data,'$.workAt.audio',0,'$.nextWorkAt',0) WHERE id=?").run(r.id);
  assert.equal((await repo.listWork({lane:'audio'})).length,0);
  const header=JSON.parse(db.prepare('SELECT data FROM aggregates WHERE id=?').get(r.id).data);
  assert.ok(header.workAt.audio>Date.now());assert.ok(header.nextWorkAt>Date.now());
  assert.deepEqual(db.prepare('SELECT payload FROM aggregate_payloads WHERE id=?').get(r.id).payload,payload);
  const parse=JSON.parse;let archives=0;JSON.parse=function(value,...args){if(typeof value==='string'&&value.includes('Stale fixture archive '))archives++;return parse(value,...args);};
  try{for(let n=0;n<10;n++)assert.equal((await repo.listWork({lane:'audio'})).length,0);assert.equal(archives,0);}finally{JSON.parse=parse;}
 }finally{db.close();}
}));

test('transient speech recovery keeps its scheduled wake after five failed attempts',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.retainAudio=false;r.audioPurged=false;r.gcAt=Date.now();
 const retryAt=Date.now()+60000,lease=retryAt+30000;
 r.sources=[{id:'mic',kind:'microphone',epoch:'e',watermark:0,lastSequence:0,asr:{state:'failed',attempts:5,error:'doubao_connection_failed',retryAt}}];
 r.chunks=[{key:'mic:e:0',sourceId:'mic',epoch:'e',sequence:0,state:'processing',attempts:5,lease,acceptedAt:Date.now(),object:r.id+'/retry.pcm'}];await repo.insert(r);
 const saved=await repo.get(r.id);assert.equal(saved.workAt.audio,lease,'recovery wakes at both retry and processing lease readiness');
 assert.equal((await repo.listWork({lane:'audio'})).length,0);
 await repo.change(r.id,value=>{value.sources[0].asr.retryAt=Date.now()-1;delete value.chunks[0].lease;value.chunks[0].state='failed';});
 assert.equal((await repo.listWork({lane:'audio'})).length,1,'transient exhausted source is still recoverable');
}));

test('a failed source with no retryable chunks does not busy poll',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.retainAudio=true;r.gcAt=Date.now();
 r.sources=[{id:'mic',watermark:0,lastSequence:0,asr:{state:'failed',attempts:1,error:'provider_unauthorized'}}];
 r.chunks=[{key:'mic:e:0',sourceId:'mic',epoch:'e',sequence:0,state:'failed',attempts:5,acceptedAt:Date.now(),object:r.id+'/terminal.pcm'}];await repo.insert(r);
 assert.equal((await repo.listWork({lane:'audio'})).length,0);
}));

test('recovery wake respects expired chunks completed chunks and cleanup while retaining deletion deadlines',async()=>{
 for(const flag of ['expired','completed','cleanup'])await fixture(async repo=>{
  const r=history();r.translationTarget='';r.retainAudio=true;r.gcAt=Date.now();
  r.sources=[{id:'mic',watermark:0,lastSequence:0,asr:{state:'failed',attempts:5,error:'doubao_connection_failed',retryAt:Date.now()-1}}];
  r.chunks=[{key:'mic:e:0',sourceId:'mic',epoch:'e',sequence:0,state:flag==='completed'?'done':'failed',attempts:5,acceptedAt:Date.now(),object:r.id+'/retained.pcm',...(flag==='expired'?{expired:true}:{})}];
  if(flag==='cleanup')r.audioCleanup=true;
  await repo.insert(r);assert.equal((await repo.listWork({lane:'audio'})).length,0,flag);
  await repo.change(r.id,value=>{value.deleteAt=new Date(Date.now()-1000).toISOString();});
  assert.equal((await repo.listWork({lane:'audio'})).length,1,'retention deletion is never hidden by recovery filtering');
 });
});

test('generic ASR pending work is not delayed by prior provider stream state',()=>fixture(async repo=>{
 const r=history();r.translationTarget='';r.retainAudio=false;r.gcAt=Date.now();
 r.sources=[{id:'mic',watermark:0,lastSequence:0,asr:{state:'failed',attempts:1,error:'doubao_connection_failed',lease:Date.now()+60000,retryAt:Date.now()+5000}}];
 r.chunks=[{key:'mic:e:0',sourceId:'mic',epoch:'e',sequence:0,state:'failed',attempts:1,acceptedAt:Date.now(),object:r.id+'/waiting.pcm'}];await repo.insert(r);
 assert.equal((await repo.listWork({lane:'audio'})).length,1,'generic worker can claim its due chunk independent of old provider source state');
}));

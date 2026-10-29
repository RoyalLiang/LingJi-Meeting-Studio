import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../services/records/src/repository.mjs';
import { publicRecord, createRecord } from '../packages/records/src/record.mjs';
import { setTranslationTarget } from '../packages/records/src/translation.mjs';
import { requireThat } from '../packages/records/src/record.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'live-translation-')),repo=await createRepository({root});
 const record=createRecord('owner');record.capture='recording';
 record.sources=[{id:'mic',epoch:'epoch',watermark:-1,lastSequence:null,asr:{state:'running',fence:'asr-fence',preview:{text:'当前正在讨论实时翻译',startMs:1000,updatedAt:Date.now()}}}];
 setTranslationTarget(record,'en',requireThat);await repo.insert(record);
 return {repo,record,root,close:async()=>{await repo.close();await rm(root,{recursive:true,force:true});}};
}
test('live ASR text is translated before a confirmed transcript segment exists',async()=>{
 const f=await fixture();try{
  const calls=[];await runCycle(f.repo,{translate:async text=>{calls.push(text);return 'Discussing live translation';}},{lane:'translation-live'});
  const r=await f.repo.get(f.record.id);
  assert.deepEqual(calls,['当前正在讨论实时翻译']);assert.equal(r.segments.length,0);
  assert.equal(r.sources[0].asr.translation.text,'Discussing live translation');
 }finally{await f.close();}
});


test('unchanged provisional text is translated once and private leases stay server-side',async()=>{
 const f=await fixture();try{
  let calls=0;const provider={translate:async()=>{calls++;return 'Live output';}};
  await runCycle(f.repo,provider,{lane:'translation-live'});await runCycle(f.repo,provider,{lane:'translation-live'});
  assert.equal(calls,1);
  const visible=publicRecord(await f.repo.get(f.record.id)).sources[0].asr.translation;
  assert.equal(visible.text,'Live output');assert.equal(visible.fence,undefined);assert.equal(visible.requestedAt,undefined);
 }finally{await f.close();}
});

for(const change of ['correction','new-utterance','pause','language'])test(`provisional translation cannot overwrite ${change}`,async()=>{
 const f=await fixture();try{
  let release;
  const work=runCycle(f.repo,{translate:()=>new Promise(resolve=>{release=resolve;})},{lane:'translation-live'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.repo.change(f.record.id,r=>{
   if(change==='pause'||change==='language')setTranslationTarget(r,change==='pause'?'':'ja',requireThat);
   else if(change==='correction')r.sources[0].asr.preview.text='实时原文已经被识别修正';
   else r.sources[0].asr.preview.startMs=5000;
  });
  release('Stale output');await work;
  const r=await f.repo.get(f.record.id);assert.notEqual(r.sources[0].asr.translation?.text,'Stale output');
 }finally{await f.close();}
});

test('a translated prefix remains provisional during append and never commits transcript text',async()=>{
 const f=await fixture();try{
  let release;const work=runCycle(f.repo,{translate:()=>new Promise(resolve=>{release=resolve;})},{lane:'translation-live'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.repo.change(f.record.id,r=>{r.sources[0].asr.preview.text+='，并核对版本';});
  release('Discussing live translation');await work;
  const r=await f.repo.get(f.record.id);assert.equal(r.sources[0].asr.translation.sourceText,'当前正在讨论实时翻译');assert.equal(r.segments.length,0);
 }finally{await f.close();}
});

test('a slow historical request never blocks the new confirmed utterance lane',async()=>{
 const f=await fixture();try{
  await f.repo.change(f.record.id,r=>{r.translationLiveFromMs=1000;r.sources[0].asr.preview=null;r.segments=[{id:'old',revision:1,text:'历史发言',startMs:0,endMs:500},{id:'new',revision:1,text:'最新发言',startMs:1000,endMs:2000}];});
  let release;const calls=[];
  const history=runCycle(f.repo,{translate:text=>{calls.push(text);return new Promise(resolve=>{release=resolve;});}},{lane:'translation'});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await runCycle(f.repo,{translate:async text=>{calls.push(text);return 'Latest';}},{lane:'translation-live'});
  assert.deepEqual(calls,['历史发言','最新发言']);assert.equal((await f.repo.get(f.record.id)).segments[1].translation,'Latest');
  release('History');await history;
 }finally{await f.close();}
});

test('exact provisional output is reused after confirmation without another model request',async()=>{
 const f=await fixture();try{
  await runCycle(f.repo,{translate:async()=> 'Cached output'},{lane:'translation-live'});
  await f.repo.change(f.record.id,r=>{r.capture='completed';r.sources[0].asr.preview=null;r.sources[0].asr.state='completed';r.segments=[{id:'final',sourceId:'mic',revision:1,text:'当前正在讨论实时翻译',startMs:1000,endMs:2000}];});
  let calls=0;await runCycle(f.repo,{translate:async()=>{calls++;return 'Duplicate';}},{lane:'translation'});
  assert.equal(calls,0);assert.equal((await f.repo.get(f.record.id)).segments[0].translation,'Cached output');
 }finally{await f.close();}
});


test('single-sentence retry preserves settings and rejects stale language or revision',async()=>{
 const f=await fixture();let app;
 try{
  const {createRecordServer}=await import('../services/records/src/server.mjs');
  app=await createRecordServer({repo:f.repo,port:0,localAccount:true});
  const address=await app.start(),base=`http://127.0.0.1:${address.port}`,cookie=await app.localSession();
  const boot=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json(),owner=(await f.repo.list('user'))[0].id;
  await f.repo.change(f.record.id,r=>{r.owner=owner;r.segments=[{id:'failed',revision:2,text:'失败发言',startMs:0,endMs:1000,translationError:'provider_rate_limited',translationAttempts:3,translationRetryAt:Date.now()+60000}];});
  const send=body=>fetch(`${base}/api/records/${f.record.id}/translation/retry`,{method:'POST',headers:{cookie,'X-CSRF-Token':boot.csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send({segmentId:'failed',revision:1,target:'en'})).status,409);
  assert.equal((await send({segmentId:'failed',revision:2,target:'ja'})).status,409);
  assert.equal((await send({segmentId:'failed',revision:2,target:'en'})).status,200);
  const r=await f.repo.get(f.record.id);assert.equal(r.translationTarget,'en');assert.equal(r.translationRevision,1);
  assert.equal(r.segments[0].translationError,undefined);assert.equal(r.segments[0].translationAttempts,undefined);
 }finally{if(app)await app.stop();else await f.repo.close();await rm(f.root,{recursive:true,force:true});}
});

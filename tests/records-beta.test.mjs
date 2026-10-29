import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAuth } from '../services/records/src/auth.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { createProductionServer } from '../apps/web/src/production-server.mjs';
import { createRecord, digest, emit } from '../packages/records/src/record.mjs';
import { truncateText } from '../packages/records/src/text.mjs';

const secret = 'synthetic-beta-authentication-secret';
test('password hashing stays compatible, yields the event loop and bounds concurrent work', async () => {
  const salt = 'synthetic-salt';
  const user = {id:'user:fixture',salt,password:scryptSync('fixture-password',salt,64).toString('hex'),authVersion:1};
  const auth = await createAuth({get:async()=>user}, {secret});
  assert.equal((await auth.login({email:'test@example.invalid',password:'fixture-password'})).id,user.id);
  let completed=0;
  const jobs=Array.from({length:8},()=>auth.login({password:'fixture-password'}).finally(()=>completed++));
  await assert.rejects(auth.login({password:'fixture-password'}),{code:'authentication_busy'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(completed<8,'password derivation must yield rather than block the API event loop');
  await Promise.all(jobs);
  await assert.rejects(auth.user({headers:{cookie:`record_session=e30.${'é'.repeat(64)}`}}),{code:'login_required'});
  assert.throws(()=>auth.checkCsrf({headers:{'x-csrf-token':'é'.repeat(64)}},user),{code:'csrf_required'});
});

test('visible text truncation preserves full graphemes and stored title UTF-8',()=>{
  const family='👨‍👩‍👧‍👦';
  assert.equal(truncateText(`a${family}b`,2),`a${family}`);
  assert.equal(truncateText('e\u0301z',1),'e\u0301');
  const record=createRecord('fixture',{title:'a'.repeat(159)+'😀x'});
  assert.equal(record.title,'a'.repeat(159)+'😀');
  assert.equal(Buffer.from(record.title).toString('utf8'),record.title);
  assert.ok(Buffer.byteLength(truncateText('a'+'\u0301'.repeat(100000),160)) <= 160*32);
});

test('share hash lookup is indexed, transactionally revoked, and legacy compressed records migrate once', async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-beta-index-'));
  let repo=await createRepository({root,databaseUrl:'',compressAggregates:true});
  try {
    const record=createRecord('fixture'), token='synthetic-beta-share-token', hash=digest(token);
    record.shares.push({id:'share',hash,expires:Date.now()+86400000,scope:'minutes',revoked:false});
    await repo.insert(record);
    repo.list=()=>{throw new Error('public shares must never list all records');};
    assert.equal((await repo.findShare(hash)).id,record.id);
    await assert.rejects(repo.change(record.id,r=>{r.shares[0].revoked=true;throw new Error('rollback');}));
    assert.ok(await repo.findShare(hash));
    await repo.close();
    const db=new DatabaseSync(join(root,'records.sqlite'));
    const before=db.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data;
    db.exec('DROP TABLE record_share_index; DROP TABLE record_share_schema');db.close();
    repo=await createRepository({root,databaseUrl:'',compressAggregates:true});
    assert.equal((await repo.findShare(hash)).id,record.id);
    const check=new DatabaseSync(join(root,'records.sqlite'));
    assert.equal(check.prepare('SELECT data FROM aggregates WHERE id=?').get(record.id).data,before,'migration must not rewrite the record');
    assert.match(check.prepare('EXPLAIN QUERY PLAN SELECT record_id FROM record_share_index WHERE hash=? AND expires>?').get(hash,Date.now()).detail,/INDEX/);check.close();
    await repo.change(record.id,r=>{r.shares[0].revoked=true;emit(r,'share.revoked');});
    assert.equal(await repo.findShare(hash),null);
  } finally {await repo.close();await rm(root,{recursive:true,force:true});}
});

test('the production proxy overwrites supplied client identity before API rate limiting',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-beta-proxy-'));
  const app=await createRecordServer({root,databaseUrl:'',port:0,secret});
  const address=await app.start();
  const web=createProductionServer({apiUrl:`http://127.0.0.1:${address.port}`});
  await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${web.address().port}/api/auth/login`;
    for(let i=0;i<20;i++)assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-record-client-ip':`192.0.2.${i+1}`},body:JSON.stringify({email:'unknown@example.invalid',password:'wrong-password'})})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-record-client-ip':'198.51.100.1'},body:'{}'})).status,429,'client headers must not evade the trusted proxy bucket');
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json','x-record-client-ip':'192.0.2.250'},body:'{}'})).status,401,'separate proxy-provided clients must retain independent budgets');
  } finally {web.closeAllConnections();await new Promise(resolve=>web.close(resolve));await app.stop();await rm(root,{recursive:true,force:true});}
});

test('the pinned reading pack supplies conservative scoped name and scene candidates',async()=>{
  const {phoneticCandidates: suggest}=await import('../packages/records/src/phonetic-vocabulary.mjs');
  const {loadRecognitionLexicon}=await import('../services/records/src/recognition-lexicon.mjs');
  const lexicon = await loadRecognitionLexicon();
  const phoneticCandidates = (segments, entries) => suggest(segments, entries, lexicon).candidates;
  const {acceptVocabularyCorrection}=await import('../packages/records/src/vocabulary.mjs');
  const names=[{kind:'names',text:'王晓明',aliases:[]},{kind:'names',text:'南山会议室',aliases:[]},{kind:'names',text:'单田芳',aliases:[]}];
  const segments=[{id:'s1',revision:1,text:'王小明在南杉会议室发言，善田芳参与。',speaker:'',sourceId:'fixture',startMs:0,endMs:1000,edited:false}];
  const candidates=phoneticCandidates(segments,names);
  assert.deepEqual(candidates.map(c=>c.replacement),['王晓明','南山会议室','单田芳']);
  const record=createRecord('fixture');record.segments=segments;
  assert.equal(record.segments[0].text,'王小明在南杉会议室发言，善田芳参与。','review is read-only');
  acceptVocabularyCorrection(record,candidates[0],names);
  assert.equal(record.segments[0].text,'王晓明在南杉会议室发言，善田芳参与。');
  assert.equal(record.segments[0].recognitionText,'王小明在南杉会议室发言，善田芳参与。');
  assert.equal(phoneticCandidates([{...segments[0],text:'王小明',edited:true,correction:undefined}],names).length,0);
  assert.equal(phoneticCandidates([{...segments[0],text:'王小明',edited:false,languageDetection:{language:'ja'}}],names).length,0);
  assert.equal(phoneticCandidates([{...segments[0],text:'王小明',edited:false}],[...names,{kind:'names',text:'王小明',aliases:[]}]).length,0,'two valid names must not be silently conflated');
});

test('record vocabulary selects common scene terms only with context and keeps account isolation',async()=>{
  const {loadRecordVocabulary,recordAsrConfig,correctionCandidates}=await import('../services/records/src/vocabulary.mjs');
  const {vocabularyId}=await import('../packages/records/src/vocabulary.mjs');
  const root=await mkdtemp(join(tmpdir(),'lingji-beta-words-')),repo=await createRepository({root,databaseUrl:''});
  try {
    await repo.insert({id:vocabularyId('one','all'),kind:'vocabulary',owner:'one',scope:'all',revision:1,terms:'',names:'王晓明'});
    const record=createRecord('one',{title:'项目复盘'});record.segments=[{id:'s',revision:1,text:'项木复盘由王小明主持。',edited:false,startMs:0,endMs:1000,sourceId:'fixture',speaker:''}];
    const words=await loadRecordVocabulary(repo,record);
    assert.ok(words.entries.some(e=>e.text==='项目复盘' && e.source==='common'));
    assert.ok(!(await loadRecordVocabulary(repo,createRecord('two'))).entries.some(e=>e.text==='王晓明'));
    assert.ok(!(await loadRecordVocabulary(repo,createRecord('two'))).entries.some(e=>e.text==='项目复盘'));
    assert.ok((await recordAsrConfig(repo,record,{})).ASR_VOCABULARY_HINTS.includes('项目复盘'));
    const result=await correctionCandidates(repo,record);
    assert.ok(result.candidates.some(c=>c.replacement==='王晓明' && c.method==='phonetic'));
    assert.ok(result.candidates.some(c=>c.replacement==='项目复盘' && c.source==='common'));
  } finally {await repo.close();await rm(root,{recursive:true,force:true});}
});

test('reading asset is fixed to its declared bytes, digest and redistribution notice',async()=>{
  const {readFile}=await import('node:fs/promises');
  const bytes=await readFile(new URL('../packages/records/src/data/mandarin-readings.json',import.meta.url));
  const manifest=JSON.parse(await readFile(new URL('../packages/records/src/data/mandarin-readings.manifest.json',import.meta.url),'utf8'));
  assert.equal(bytes.length,manifest.bytes);assert.equal(digest(bytes),manifest.sha256);assert.equal(Object.keys(JSON.parse(bytes).readings).length,manifest.characters);
  assert.match(await readFile(new URL('../packages/records/src/data/UNICODE-LICENSE.txt',import.meta.url),'utf8'),/UNICODE LICENSE V3/);
});

test('unrelated worker lanes avoid aggregate transactions for empty work',async()=>{
  const {runCycle}=await import('../services/records/src/worker.mjs');
  const root=await mkdtemp(join(tmpdir(),'lingji-beta-idle-')),repo=await createRepository({root,databaseUrl:''});
  try {
    const record=createRecord('fixture');await repo.insert(record);
    let transactions=0;
    const change=repo.change;repo.change=(...args)=>{transactions++;return change(...args);};
    await runCycle(repo,{}, {lane:'translation'});await runCycle(repo,{}, {lane:'minutes'});
    assert.equal(transactions,0);
  } finally {await repo.close();await rm(root,{recursive:true,force:true});}
});

test('a missing or corrupt optional reading pack degrades without losing alias checks',async()=>{
  const {readRecognitionLexicon}=await import('../services/records/src/recognition-lexicon.mjs');
  const {vocabularyCandidates}=await import('../packages/records/src/vocabulary.mjs');
  const {writeFile}=await import('node:fs/promises');
  const {pathToFileURL}=await import('node:url');
  const root=await mkdtemp(join(tmpdir(),'lingji-bad-pack-'));
  try {
    assert.equal((await readRecognitionLexicon(pathToFileURL(root+'/'))).available,false);
    await writeFile(join(root,'mandarin-readings.json'),'{invalid');await writeFile(join(root,'mandarin-readings.manifest.json'),'{}');
    assert.equal((await readRecognitionLexicon(pathToFileURL(root+'/'))).available,false);
    assert.equal(vocabularyCandidates([{id:'s',revision:1,text:'王小明'}],[{kind:'names',text:'王晓明',aliases:['王小明']}]).length,1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('phonetic review reports the actual bounded window independently from alias review',async()=>{
  const {correctionCandidates}=await import('../services/records/src/vocabulary.mjs');
  const root=await mkdtemp(join(tmpdir(),'lingji-review-window-')),repo=await createRepository({root,databaseUrl:''});
  try {
    const record=createRecord('fixture');record.segments=Array.from({length:4},(_,i)=>({id:`s${i}`,revision:1,text:'甲'.repeat(6000),edited:false,startMs:i*1000}));
    const result=await correctionCandidates(repo,record);
    assert.equal(result.reviewedSegments,4);assert.equal(result.phoneticReview.reviewedSegments,2);assert.equal(result.phoneticReview.limited,true);
  } finally {await repo.close();await rm(root,{recursive:true,force:true});}
});

test('oversized optional reading files degrade before JSON parsing',async()=>{
  const {readRecognitionLexicon}=await import('../services/records/src/recognition-lexicon.mjs');
  const root=await mkdtemp(join(tmpdir(),'lingji-pack-bound-'));
  try{await writeFile(join(root,'mandarin-readings.json'),'x'.repeat(1000001));await writeFile(join(root,'mandarin-readings.manifest.json'),'{}');assert.equal((await readRecognitionLexicon(new URL(`file://${root}/`))).available,false);}
  finally{await rm(root,{recursive:true,force:true});}
});

test('anonymous invalid share tokens have a bounded read budget',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-share-limit-')),app=await createRecordServer({root,databaseUrl:'',port:0,secret});
  const address=await app.start();
  try {
    let lookups=0;app.repo.findShare=async()=>{lookups++;return null;};
    for(let i=0;i<60;i++)assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/shared/${'a'.repeat(43)}`)).status,404);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/shared/${'b'.repeat(43)}`)).status,429);
    assert.equal(lookups,60);
  } finally {await app.stop();await rm(root,{recursive:true,force:true});}
});

test('desktop shutdown lets an owned in-flight lane finish before closing Realtime',async()=>{
  const vm=await import('node:vm');
  const {startDesktopBackend}=await import('../services/records/src/desktop-backend.mjs');
  let release, finished=false, closed=false, stopped=false;
  const inflight=new Promise(resolve=>{release=resolve;});
  const repo={list:async()=>[]};
  const noop=async()=>{};
  const context={process:{env:{},umask(){},pid:1,version:process.version},setTimeout,console,join,
    mkdir:noop,recoverTemporaryAudio:noop,migrateBundledAsr:noop,recoverLocalWork:noop,writeFile:noop,openLocalAsr(){},closeLocalAsr:noop,closeSpeakerStreams(){},
    DatabaseSync:class{prepare(){return{get:()=>({version:'3.53.4'})};}exec(){}close(){}},
    createRepository:async()=>repo,createRecordServer:async()=>({start:async()=>({port:1}),localSession:async()=>'',stop:async()=>{stopped=true;}}),
    runCycle:async(_repo,_providers,{lane})=>{if(lane==='minutes'){await inflight;finished=true;}},
    closeRealtime(){assert.equal(finished,true);closed=true;}
  };
  const start=vm.runInNewContext(`(${startDesktopBackend.toString()})`,context);
  const backend=await start({root:'/synthetic-only',workers:true});
  const stopping=backend.stop();await new Promise(resolve=>setImmediate(resolve));
  try {assert.equal(closed,false);assert.equal(stopped,false);} finally {release();}
  await stopping;assert.equal(closed,true);assert.equal(stopped,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRecord, addSource, acknowledge, seal, commitTranscriptBatch, editSegment } from '../packages/records/src/record.mjs';
import { parseVocabulary, vocabularyCandidates, vocabularyHints, vocabularyId, acceptVocabularyCorrection } from '../packages/records/src/vocabulary.mjs';
import { loadVocabulary, recordAsrConfig, correctionCandidates } from '../services/records/src/vocabulary.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { doubaoRecognitionForLanguage, doubaoAudioConfig } from '../services/records/src/asr-terms.mjs';
import { transcribe } from '../services/records/src/providers.mjs';
import { normalizeConfig } from '../services/records/src/config.mjs';

const sample = text => ({id:randomUUID(),revision:1,sourceId:'text-import',startMs:0,endMs:0,text,speaker:'',edited:false});
const vocabulary = {terms:'Redis Sentinel | Redis 森提诺\n缓存',names:'聆记 | 灵记\n王晓明 | 王小明'};
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(),'lingji-vocabulary-')), repo = await createRepository({root,databaseUrl:''});
  try { await work(repo,root); } finally { await repo.close(); await rm(root,{recursive:true,force:true}); }
}

test('vocabulary validates bounds, retains name aliases, and prioritizes relevant recognition hints', () => {
  const entries = parseVocabulary(vocabulary);
  assert.equal(entries[2].kind,'names'); assert.deepEqual(entries[2].aliases,['灵记']);
  assert.equal(vocabularyHints(entries,'王晓明讨论',4)[0],'王晓明');
  assert.ok(vocabularyHints(entries,'').join('').length<=100);
  assert.throws(()=>parseVocabulary({terms:'a'.repeat(51)}),{code:'invalid_vocabulary'});
  assert.throws(()=>parseVocabulary({names:'name\u0000'}),{code:'invalid_vocabulary'});
  assert.throws(()=>parseVocabulary({terms:Array(201).fill('word').join('\n')}),{code:'invalid_vocabulary'});
});

test('aliases produce reviewable spans without replacing Latin substrings or human text', () => {
  const entries=parseVocabulary({terms:'Anna | Ann\nRedis Sentinel | Redis 森提诺'});
  const untouched=sample('Annual summary; Ann said 我们 use Redis 森提诺 做缓存。');
  const candidates=vocabularyCandidates([untouched,{...sample('Ann'),edited:true}],entries);
  assert.deepEqual(candidates.map(c=>c.original),['Ann','Redis 森提诺']);
  assert.equal(untouched.text,'Annual summary; Ann said 我们 use Redis 森提诺 做缓存。');
});

test('confirmed correction preserves recognition original, creates revision, revokes translation, and rejects stale/human writes', () => {
  const record=createRecord('owner'), segment=sample('王小明决定不要删除缓存。'); record.segments.push(segment);
  Object.assign(segment,{translation:'wrong target',translationLanguage:'en',translationFence:'old',translationLease:Date.now()+5000});
  const entries=parseVocabulary(vocabulary), [candidate]=vocabularyCandidates([segment],entries);
  acceptVocabularyCorrection(record,candidate,entries);
  assert.equal(segment.text,'王晓明决定不要删除缓存。'); assert.equal(segment.revision,2);
  assert.equal(segment.recognitionText,'王小明决定不要删除缓存。'); assert.equal(segment.versions[0].text,segment.recognitionText);
  assert.equal(segment.translation,undefined); assert.equal(segment.translationFence,undefined);
  assert.throws(()=>acceptVocabularyCorrection(record,candidate,entries),{code:'segment_revision_conflict'});
  editSegment(record,segment.id,{revision:2,text:'王晓明人工确认，不要删除缓存。'});
  assert.equal(segment.recognitionText,'王小明决定不要删除缓存。');
});

test('account and directory vocabulary is isolated and survives repository reopening', async () => fixture(async(repo,root) => {
  await repo.insert({id:vocabularyId('one','all'),kind:'vocabulary',owner:'one',scope:'all',revision:1,...vocabulary});
  await repo.insert({id:vocabularyId('one','project'),kind:'vocabulary',owner:'one',scope:'project',revision:1,terms:'QTruck',names:''});
  assert.equal((await loadVocabulary(repo,'two','project')).entries.length,0);
  const common=await loadVocabulary(repo,'one','inbox'), local=await loadVocabulary(repo,'one','project');
  assert.equal(local.entries.length,common.entries.length+1);
  const record={...createRecord('one'),title:'QTruck 周会',workspaceId:'project'};
  assert.ok((await recordAsrConfig(repo,record,{})).ASR_VOCABULARY_HINTS.includes('QTruck'));
  const second=await createRepository({root,databaseUrl:''});
  try { assert.deepEqual((await loadVocabulary(second,'one','project')).entries,local.entries); } finally { await second.close(); }
}));

test('manual model review is constrained to current segment text and canonical vocabulary', async () => fixture(async repo => {
  await repo.insert({id:vocabularyId('one','all'),kind:'vocabulary',owner:'one',revision:1,...vocabulary});
  const record={...createRecord('one'),segments:[sample('灵记准备上线。')]}, segment=record.segments[0];
  const result=await correctionCandidates(repo,record,{model:true,complete:async messages=>{
    assert.match(messages[0].content,/不翻译/);
    return {corrections:[{segmentId:segment.id,revision:1,original:'灵记',replacement:'聆记'}]};
  }});
  assert.equal(result.candidates.length,1); assert.equal(record.segments[0].text,'灵记准备上线。');
  await assert.rejects(correctionCandidates(repo,record,{model:true,complete:async()=>({corrections:[{segmentId:segment.id,revision:1,original:'上线',replacement:'下线'}]})}),{code:'invalid_corrections'});
  const human={...record,segments:[{...segment,edited:true}]}; let invoked=false;
  await correctionCandidates(repo,human,{model:true,complete:async()=>{invoked=true;return {corrections:[]};}}); assert.equal(invoked,false);
}));

test('automatic ASR mode obeys provider endpoint rules and keeps hint budgets', async () => {
  assert.equal(createRecord('one').language,'auto');
  assert.throws(()=>createRecord('one',{language:'auto\nother'}),{code:'invalid_recognition_language'});
  const config={DOUBAO_ASR_URL:'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',DOUBAO_ASR_HOTWORDS:'Redis',ASR_VOCABULARY_HINTS:['聆记','Redis','王晓明']};
  assert.equal(doubaoRecognitionForLanguage(config,'auto').enable_nonstream,true);
  assert.deepEqual(JSON.parse(doubaoRecognitionForLanguage(config,'auto').corpus.context).hotwords,[{word:'Redis'},{word:'聆记'},{word:'王晓明'}]);
  assert.equal(doubaoAudioConfig({...config,DOUBAO_ASR_URL:config.DOUBAO_ASR_URL.replace('async','nostream')},'auto').language,undefined);
  const oldFetch=globalThis.fetch; let body,url;
  globalThis.fetch=async(address,options)=>{url=String(address);body=options.body;return Response.json(address instanceof URL ? {results:{channels:[{alternatives:[{transcript:'我们 use Redis。'}]}]}} : {text:'我们 use Redis。'});};
  try {
    await transcribe(Buffer.alloc(3200),{language:'auto'},{},normalizeConfig({ASR_PROVIDER:'openai-compatible',ASR_API_URL:'https://test.invalid/transcriptions',ASR_API_KEY:'fixture-key',ASR_VOCABULARY_HINTS:['聆记']}));
    assert.equal(body.get('language'),null); assert.equal(body.get('prompt'),'聆记');
    await transcribe(Buffer.alloc(3200),{language:'auto'},{},normalizeConfig({ASR_PROVIDER:'deepgram',DEEPGRAM_API_KEY:'fixture-key',ASR_VOCABULARY_HINTS:['聆记']}));
    assert.equal(new URL(url).searchParams.get('language'),'multi'); assert.deepEqual(new URL(url).searchParams.getAll('keyterm'),['聆记']);
  } finally { globalThis.fetch=oldFetch; }
});

test('language metadata follows durable audio boundaries and survives edits without falsely relabeling text', () => {
  const record=createRecord('owner'),source=addSource(record,{kind:'microphone'});
  acknowledge(record,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:32000,sampleRate:16000,digest:'fixture',object:'fixture'});
  seal(record,[{sourceId:source.id,epoch:source.epoch,lastSequence:0}]);
  commitTranscriptBatch(record,[record.chunks[0].key],'我们 use Redis。',record.generation,'sensevoice-small',{provider:'sensevoice-local',language:'zh'});
  assert.equal(record.segments[0].endMs,2000); assert.equal(record.segments[0].languageDetection.scope,'audio-batch');
  editSegment(record,record.segments[0].id,{revision:1,text:'我们使用 Redis。'});
  assert.equal(record.segments[0].languageDetection.revision,1); assert.equal(record.segments[0].revision,2);
});

test('mixed-language confirmed sentences translate completely and late results cannot overwrite a confirmed correction', async () => fixture(async(repo,root) => {
  await writeFile(join(root,'providers.json'),JSON.stringify({RECORD_LEARNING_ENABLED:'false'}));
  const record={...createRecord('owner'),segments:[sample('我们 use Redis，王小明负责。')],translationTarget:'en'}; await repo.insert(record);
  let release,started;const waiting=new Promise(r=>{release=r;}),ready=new Promise(r=>{started=r;});
  const running=runCycle(repo,{translate:async(text,target)=>{assert.equal(text,'我们 use Redis，王小明负责。');assert.equal(target,'en');started();await waiting;return 'STALE';}},{lane:'translation'});
  await ready;
  await repo.change(record.id,r=>acceptVocabularyCorrection(r,vocabularyCandidates(r.segments,parseVocabulary(vocabulary))[0],parseVocabulary(vocabulary)));
  release(); await running; assert.equal((await repo.get(record.id)).segments[0].translation,undefined);
  await runCycle(repo,{translate:async(text,target)=>{assert.match(text,/王晓明/);assert.equal(target,'en');return 'We use Redis; Wang Xiaoming is responsible.';}},{lane:'translation'});
  assert.equal((await repo.get(record.id)).segments[0].translationLanguage,'en');
}));

test('HTTP vocabulary and correction workflow enforces ownership, revisions and language switch draining', async () => {
  const root=await mkdtemp(join(tmpdir(),'lingji-vocabulary-api-')),app=await createRecordServer({root,databaseUrl:'',port:0}),address=await app.start();
  const base=`http://127.0.0.1:${address.port}/api`; let headers={'Content-Type':'application/json'};
  const call=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};};
  try {
    const auth=await call('/auth/register','POST',{email:'vocabulary@example.test',password:'fixture-password'});
    headers={...headers,Cookie:auth.cookie.split(';')[0],'X-CSRF-Token':auth.data.csrf};
    const record=(await call('/records','POST',{})).data;
    assert.equal((await call('/workspaces/all/vocabulary','PUT',{...vocabulary,revision:0})).status,200);
    assert.equal((await call('/workspaces/all/vocabulary','PUT',{...vocabulary,revision:0})).status,409);
    await call(`/records/${record.id}/import-text`,'POST',{text:'灵记由王小明介绍。'});
    const review=(await call(`/records/${record.id}/corrections`)).data; assert.equal(review.candidates.length,2);
    const accepted=await call(`/records/${record.id}/corrections`,'POST',{...review.candidates[0],fingerprint:review.fingerprint});
    assert.equal(accepted.status,200); assert.equal(accepted.data.segments[0].revision,2);
    assert.equal((await call(`/records/${record.id}/corrections`,'POST',{...review.candidates[0],fingerprint:review.fingerprint})).status,409);
    const otherRecord=await app.repo.insert({...createRecord('foreign'),segments:[sample('秘密')],capture:'completed'});
    assert.equal((await call(`/records/${otherRecord.id}/corrections`)).status,404);
    const fresh=(await call('/records','POST',{})).data;
    assert.equal((await call(`/records/${fresh.id}`,'PATCH',{language:'ja'})).status,200);
    await call(`/records/${fresh.id}/sources`,'POST',{kind:'microphone'});
    assert.equal((await call(`/records/${fresh.id}`,'PATCH',{language:'auto'})).status,409);
  } finally { await app.stop(); await rm(root,{recursive:true,force:true}); }
});

test('sequential vocabulary confirmations keep other candidates while manual edits stay protected', () => {
  const record={...createRecord('owner'),segments:[sample('灵记由王小明介绍。')]}, entries=parseVocabulary(vocabulary);
  acceptVocabularyCorrection(record,vocabularyCandidates(record.segments,entries)[0],entries);
  const remaining=vocabularyCandidates(record.segments,entries); assert.equal(remaining.length,1); assert.equal(remaining[0].revision,2);
  acceptVocabularyCorrection(record,remaining[0],entries); assert.equal(record.segments[0].text,'聆记由王晓明介绍。');
  assert.equal(record.segments[0].recognitionText,'灵记由王小明介绍。');
  editSegment(record,record.segments[0].id,{revision:3,text:'灵记由王小明介绍，这是人工写法。'});
  assert.equal(vocabularyCandidates(record.segments,entries).length,0);
});

test('multiple confirmed spans create one revision and overlapping proposals cannot corrupt original', () => {
  const record={...createRecord('owner'),segments:[sample('灵记由王小明介绍。')]}, entries=parseVocabulary(vocabulary), changes=vocabularyCandidates(record.segments,entries);
  assert.throws(()=>acceptVocabularyCorrection(record,{...changes[0],changes:[changes[0],changes[0]]},entries),{code:'invalid_correction'});
  assert.equal(record.segments[0].text,'灵记由王小明介绍。');
  acceptVocabularyCorrection(record,{...changes[0],changes},entries);
  assert.equal(record.segments[0].text,'聆记由王晓明介绍。'); assert.equal(record.segments[0].revision,2);
});

test('generic translation uses configured model instead of sending Seed options to an incompatible endpoint', async () => {
  const {translateText,providerStatus}=await import('../services/records/src/providers.mjs');
  const {translationConnection}=await import('../services/records/src/seed-translation.mjs');
  const config={LLM_API_URL:'https://fixture.invalid/v1/responses',LLM_API_KEY:'fixture-key',LLM_MODEL:'configured-text-model',LLM_PROTOCOL:'responses'};
  assert.equal(translationConnection(config).provider,'text-model'); assert.equal(providerStatus(config).translation,true);
  assert.equal(translationConnection({...config,LLM_API_URL:'https://ark.cn-beijing.volces.com/api/v3/responses'}).provider,'doubao-seed');
  assert.equal(translationConnection({...config,TRANSLATION_PROVIDER:'doubao-seed'}).provider,'doubao-seed');
  const oldFetch=globalThis.fetch;let requested;
  globalThis.fetch=async(_url,options)=>{requested=JSON.parse(options.body);return Response.json({output_text:JSON.stringify({translation:'We use Redis. Please keep the recording.'})});};
  try {
    assert.equal(await translateText('我们用 Redis。Please keep the recording.','en',config),'We use Redis. Please keep the recording.');
    assert.equal(requested.model,'configured-text-model'); assert.deepEqual(JSON.parse(requested.input[1].content),{target:'en',text:'我们用 Redis。Please keep the recording.'});
    assert.equal(requested.input[1].translation_options,undefined);
  } finally {globalThis.fetch=oldFetch;}
});

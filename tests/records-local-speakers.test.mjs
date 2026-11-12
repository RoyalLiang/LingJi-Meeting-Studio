import {voiceLearning} from '../services/records/src/voiceprint-learning.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRepository } from '../services/records/src/repository.mjs';
import { voiceprints } from '../services/records/src/voiceprints.mjs';
import { normalizedVoice, voiceSimilarity, validDiarization, labelLocalTurns } from '../services/records/src/local-speakers.mjs';
import { LOCAL_SPEAKER_MODEL } from '../services/records/src/local-asr.mjs';
import { workspaceRoutes } from '../services/records/src/workspace-routes.mjs';
import { createRecord, addSource, acknowledge, commitTranscriptBatch, digest, pause, editSegment, audioPurgeReady } from '../packages/records/src/record.mjs';

const vector = index => Array.from({ length: 512 }, (_, at) => at === index ? 1 : 0);
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-voiceprint-')), prior = process.env.LINGJI_LOCAL_ASR_DIR;
  process.env.LINGJI_LOCAL_ASR_DIR = root;
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ speakerModels: { model: LOCAL_SPEAKER_MODEL } }));
  const repo = await createRepository({ root });
  try {
    const record = createRecord('owner', { language: 'zh', autoMinutes: false }), source = addSource(record, { kind: 'microphone' }); await repo.insert(record);
    for (let sequence = 0; sequence < 3; sequence++) {
      const bytes = Buffer.alloc(32000, 5), object = await repo.putAudio(record.id, bytes);
      await repo.change(record.id, r => acknowledge(r, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence, sampleOffset: sequence * 16000, sampleCount: 16000, sampleRate: 16000, digest: digest(bytes), ...object }));
    }
    await repo.change(record.id, r => { pause(r, [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 2 }]); commitTranscriptBatch(r, r.chunks.map(chunk => chunk.key), '这是一段获得授权的独立发言。', r.generation, 'local-model', { provider: 'sensevoice-local' }); });
    const current = await repo.get(record.id), segment = current.segments[0], input = { recordId: record.id, segmentId: segment.id, revision: segment.revision, name: '小林', consent: true, libraryRevision: 0, requestId: randomUUID() };
    await work({ root, repo, record: current, segment, source, input });
  } finally {
    if (prior === undefined) delete process.env.LINGJI_LOCAL_ASR_DIR; else process.env.LINGJI_LOCAL_ASR_DIR = prior;
    await repo.close(); await rm(root, { recursive: true, force: true });
  }
}

test('local speaker vectors are bounded and volatile; canonical turns contain exact audio evidence without vectors', async () => fixture(async ({ record, source }) => {
  assert.equal(normalizedVoice([1]), null); assert.equal(normalizedVoice(Array(512).fill(Infinity)), null); assert.equal(normalizedVoice(Array(512).fill(0)), null);
  assert.equal(voiceSimilarity(vector(0), vector(1)), 0);
  const turns = [{ text: '第一位发言。', startMs: 0, endMs: 1000, embedding: vector(0), overlap: false }, { text: '第二位发言。', startMs: 1000, endMs: 3000, embedding: vector(1), overlap: false }];
  const slices = turns.map(turn => ({ start: turn.startMs * 16, end: turn.endMs * 16, overlap: turn.overlap, embedding: turn.embedding }));
  assert.equal(validDiarization(slices, 3000), true); assert.equal(validDiarization(slices, 2999), false);
  const labeled = labelLocalTurns(record, turns); assert.notEqual(labeled[0].speakerId, labeled[1].speakerId); assert.equal(labelLocalTurns(record, [turns[0]])[0].speakerId, labeled[0].speakerId);
  assert.equal(JSON.stringify(labeled).includes('embedding'), false);
  for (const chunk of record.chunks) chunk.state = 'pending'; record.segments = [];
  commitTranscriptBatch(record, record.chunks.map(chunk => chunk.key), turns.map(turn => turn.text).join(' '), record.generation, 'sensevoice', { provider: 'sensevoice-local', turns: labeled });
  assert.equal(record.segments.length, 2); assert.equal(record.segments[0].chunkKeys.length, 1); assert.equal(record.segments[1].chunkKeys.length, 2);
  assert.equal(record.segments[0].speakerId, labeled[0].speakerId); assert.equal(record.segments[0].sourceId, source.id);
  assert.equal(JSON.stringify(record).includes('embedding'), false);
  const overlap = labelLocalTurns(record, [{ ...turns[0], overlap: true }]); assert.equal(overlap[0].speakerId, undefined);
}));

test('workspace voiceprints require opt in, encrypt vectors, isolate owners/scopes, match only on request, and revoke idempotently', async () => fixture(async ({ root, repo, input }) => {
  let calls = 0;
  const registry = voiceprints(repo, { infer: async (pcm, config, options) => { calls++; assert.equal(pcm.length, 96000); assert.equal(options.embedding, true); return { embedding: vector(0) }; } });
  await assert.rejects(registry.enroll('owner', 'inbox', { ...input, consent: false }), { code: 'voiceprint_consent_required' });
  await assert.rejects(registry.enroll('other', 'inbox', input), { code: 'record_not_found' });
  await assert.rejects(registry.enroll('owner', randomUUID(), input), { code: 'record_not_found' });
  await assert.rejects(registry.enroll('owner', 'inbox', { ...input, revision: 99 }), { code: 'voiceprint_source_changed' });
  const enrolled = await registry.enroll('owner', 'inbox', input); assert.equal(enrolled.name, '小林');
  await registry.enroll('owner', 'inbox', input); assert.equal(calls, 1);
  const stored = (await repo.list('voiceprints')).find(value => value.entries.length);
  assert.equal(stored.entries[0].sealed.includes('vector'), false); assert.equal(JSON.stringify(stored).includes('"vector"'), false); assert.equal(stored.entries[0].consentVersion, 1);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, 'integrations.key'))).mode & 0o777, 0o600);
  assert.deepEqual((await registry.list('other', 'inbox')).entries, []);
  assert.deepEqual((await registry.match('owner', 'inbox', input)).matches, [{ id: enrolled.id, name: '小林', similarity: 1 }]);
  const published = JSON.stringify(await registry.list('owner', 'inbox')); assert.equal(published.includes('sealed'), false); assert.equal(published.includes('vector'), false);
  await registry.revoke('owner', 'inbox', enrolled.id); await registry.revoke('owner', 'inbox', enrolled.id);
  assert.deepEqual((await registry.list('owner', 'inbox')).entries, []);
  assert.deepEqual(await registry.match('owner', 'inbox', input), { matches: [] });
  await assert.rejects(registry.enroll('owner', 'inbox', input), { code: 'voiceprint_library_changed' });
  assert.equal((await repo.get(stored.id)).entries.length, 0);
}));

test('enrollment rejects source edits during inference and route access requires the owning workspace', async () => fixture(async ({ repo, record, input }) => {
  const registry = voiceprints(repo, { infer: async () => { await repo.change(record.id, r => editSegment(r, input.segmentId, {revision:input.revision,text:'编辑后的内容',speaker:''})); return { embedding: vector(0) }; } });
  await assert.rejects(registry.enroll('owner', 'inbox', input), { code: 'voiceprint_source_changed' });
  assert.deepEqual((await registry.list('owner', 'inbox')).entries, []);
  let response;
  await workspaceRoutes({ req: { method: 'GET', url: '/api/workspaces/inbox/voiceprints' }, res: {}, path: '/api/workspaces/inbox/voiceprints', repo, user: { id: 'owner' }, readBody: async () => ({}), send: (_, status, body) => { response = { status, body }; } });
  assert.equal(response.status, 200); assert.equal(response.body.available, true);
  await assert.rejects(workspaceRoutes({ req: { method: 'GET' }, res: {}, path: `/api/workspaces/${randomUUID()}/voiceprints`, repo, user: { id: 'owner' } }), { code: 'workspace_not_found' });
}));

test('voiceprint inference rejects expired or overlapping source audio and unknown request bodies', async () => fixture(async ({ repo, record, input }) => {
  const registry = voiceprints(repo, { infer: async () => assert.fail('invalid clip must not reach native model') });
  await assert.rejects(registry.enroll('owner', 'inbox', null), { code: 'voiceprint_consent_required' });
  await repo.change(record.id, r => { r.segments[0].overlappingSpeech = true; });
  await assert.rejects(registry.enroll('owner', 'inbox', input), { code: 'voiceprint_audio_unavailable' });
  await repo.change(record.id, r => { delete r.segments[0].overlappingSpeech; r.chunks[0].expired = true; });
  await assert.rejects(registry.enroll('owner', 'inbox', input), { code: 'voiceprint_audio_unavailable' });
}));

async function nativeFailureFixture(mode, work) {
  const { mkdir } = await import('node:fs/promises'), { dirname } = await import('node:path'), { createHash } = await import('node:crypto');
  const { openLocalAsr, closeLocalAsr, LOCAL_ASR_MODEL } = await import('../services/records/src/local-asr.mjs');
  const root = await mkdtemp(join(tmpdir(), 'lingji-speaker-crash-')), files = [];
  try {
    const sdk = `const fs=require('node:fs'),path=require('node:path');exports.OfflineRecognizer=class {constructor(c){fs.writeFileSync(path.join(path.dirname(c.modelConfig.senseVoice.model),'../core-started'),'1')}createStream(){return {acceptWaveform(){}}}decode(){}getResult(){return {text:'健康的最终正文',lang:'<|zh|>'}}};exports.Vad=class{reset(){}acceptWaveform(){}flush(){}isEmpty(){return false}};exports.SpeakerEmbeddingExtractor=class{constructor(c){fs.writeFileSync(path.join(path.dirname(c.model),'../speaker-started'),'1');${mode === 'crash' ? 'process.exit(7)' : mode === 'stall' ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)' : ''}}createStream(){return {acceptWaveform(){},inputFinished(){}}}isReady(){return true}compute(){const v=new Float32Array(512);v[0]=1;return v}};exports.OfflineSpeakerDiarization=class{process(){return [{start:.2,end:1,speaker:0},{start:1.5,end:2.5,speaker:1}]}};`;
    const contents = { 'sensevoice/model.int8.onnx': 'test model', 'sensevoice/tokens.txt': 'test tokens', 'silero_vad.onnx': 'test vad', 'speakers/segmentation.int8.onnx': 'test segmentation', 'speakers/embedding.onnx': 'test embedding', 'node_modules/sherpa-onnx-node/index.js': sdk, 'node_modules/sherpa-onnx-node/package.json': '{"main":"index.js"}', 'package.json': '{}' };
    const prefix = `node_modules/sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}/`, nativeFiles = ['sherpa.node', 'a.dylib', 'b.dylib'].map(name => prefix + name);
    for (const path of nativeFiles) contents[path] = 'synthetic resource';
    for (const [path, value] of Object.entries(contents)) {
      const bytes = Buffer.from(value); await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
      files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ model: LOCAL_ASR_MODEL, runtime: '1.13.8', platform: process.platform, arch: process.arch, files, nativeFiles, speakerModels: { model: LOCAL_SPEAKER_MODEL } }));
    openLocalAsr(); await work(root);
  } finally { await closeLocalAsr(); openLocalAsr(); await rm(root, { recursive: true, force: true }); }
}

test('optional speaker process crash falls back to healthy SenseVoice without losing final audio', { timeout: 15000 }, async () => nativeFailureFixture('crash', async root => {
  const { transcribeLocalAsr } = await import('../services/records/src/local-asr.mjs'); const started = performance.now();
  const result = await transcribeLocalAsr(Buffer.alloc(96000), { LINGJI_LOCAL_ASR_DIR: root }, { metadata: true, diarize: true });
  assert.equal(result.text, '健康的最终正文'); assert.equal(result.diarizationError, 'local_diarization_unavailable'); assert.ok(performance.now() - started < 3000);
  const second = await transcribeLocalAsr(Buffer.alloc(96000), { LINGJI_LOCAL_ASR_DIR: root }, { metadata: true, diarize: true }); assert.equal(second.text, '健康的最终正文');
}));

test('shutdown during optional speaker startup cannot reopen the final inference registry', { timeout: 15000 }, async () => nativeFailureFixture('stall', async root => {
  const { transcribeLocalAsr, closeLocalAsr } = await import('../services/records/src/local-asr.mjs');
  const pending = transcribeLocalAsr(Buffer.alloc(96000), { LINGJI_LOCAL_ASR_DIR: root }, { metadata: true, diarize: true });
  const rejected = assert.rejects(pending, { code: 'local_asr_shutdown' });
  let started = false;
  for (let i = 0; i < 150; i++) { try { await stat(join(root, 'speaker-started')); started = true; break; } catch {} await new Promise(done => setTimeout(done, 10)); }
  assert.equal(started, true); await closeLocalAsr(); await rejected;
  await assert.rejects(stat(join(root, 'core-started')), { code: 'ENOENT' });
}));

test('partial diarization keeps uncovered speech in canonical final turns', async () => nativeFailureFixture('partial', async root => {
  const { transcribeLocalAsr } = await import('../services/records/src/local-asr.mjs');
  const result = await transcribeLocalAsr(Buffer.alloc(96000), { LINGJI_LOCAL_ASR_DIR: root }, { metadata: true, diarize: true });
  assert.equal(result.diarizationError, undefined); assert.equal(result.turns.length, 5);
  assert.deepEqual(result.turns.map(turn => [turn.startMs, turn.endMs]), [[0, 200], [200, 1000], [1000, 1500], [1500, 2500], [2500, 3000]]);
  assert.equal(result.turns.reduce((duration, turn) => duration + turn.endMs - turn.startMs, 0), 3000);
  assert.equal(result.turns[2].embedding, undefined);
}));

test('more than 64 diarization slices fail explicitly so callers can use complete final audio', async () => nativeFailureFixture('partial', async root => {
  const { createLocalSpeakerInference } = await import('../services/records/src/local-speaker-inference.mjs');
  const inference = await createLocalSpeakerInference(root, {
    SpeakerEmbeddingExtractor: class {},
    OfflineSpeakerDiarization: class { process() { return Array.from({ length: 70 }, (_, i) => ({ start: i * .375, end: i * .375 + .3, speaker: 0 })); } },
  });
  assert.throws(() => inference.diarize(new Float32Array(420000)), /too_many_speaker_slices/);
}));

test('revoke before first vault insertion invalidates delayed enrollment without retaining tombstones', async () => fixture(async ({ repo, input }) => {
  const registry = voiceprints(repo, { infer: async () => ({ embedding: vector(0) }) }), insert = repo.insert.bind(repo);
  let release, reached; const gate = new Promise(done => { release = done; }), ready = new Promise(done => { reached = done; }); let intercepted = false;
  repo.insert = async value => { if (value.kind === 'voiceprints' && !intercepted) { intercepted = true; reached(); await gate; } return insert(value); };
  const pending = registry.enroll('owner', 'inbox', input), rejected = assert.rejects(pending, { code: 'voiceprint_library_changed' });
  await ready; const first = await registry.revoke('owner', 'inbox', input.requestId, 0); release(); await rejected;
  assert.equal(first.revision, 1); assert.deepEqual(await registry.revoke('owner', 'inbox', input.requestId, 0), first);
  const stored = (await repo.list('voiceprints')).find(bank=>bank.scope==='inbox'); assert.equal(stored.entries.length, 0); assert.equal(stored.revoked, undefined);
}));

test('revocation remains available after many prior library changes', async () => fixture(async ({ repo, input }) => {
  const registry = voiceprints(repo, { infer: async () => ({ embedding: vector(0) }) });
  await registry.enroll('owner', 'inbox', input); const stored = (await repo.list('voiceprints')).find(bank=>bank.scope==='inbox');
  await repo.change(stored.id, value => { value.revision = 10000; });
  await registry.revoke('owner', 'inbox', input.requestId, 0);
  assert.equal((await registry.list('owner', 'inbox')).entries.length, 0);
}));

test('same-speaker pauses retain ASR context without crossing another or unknown speaker boundary',async()=>nativeFailureFixture('partial',async root=>{
 const {createLocalSpeakerInference}=await import('../services/records/src/local-speaker-inference.mjs');let spans=[{start:0.1,end:0.8,speaker:0},{start:1.4,end:2,speaker:0},{start:2.5,end:3,speaker:0}];const embedded=[];
 const inference=await createLocalSpeakerInference(root,{
  SpeakerEmbeddingExtractor:class{createStream(){return {acceptWaveform:({samples})=>embedded.push(samples.length),inputFinished(){}};}isReady(){return true;}compute(){return vector(0);}},
  OfflineSpeakerDiarization:class{process(){return spans;}},
 });
 const same=inference.diarize(new Float32Array(48000));assert.equal(same.length,1);assert.equal(same[0].start,1600);assert.equal(same[0].end,48000);assert.deepEqual(embedded,[28800]);
 spans=[{start:0.1,end:0.8,speaker:0},{start:1,end:1.8,speaker:1},{start:2,end:2.8,speaker:0}];assert.deepEqual(inference.diarize(new Float32Array(48000)).map(turn=>turn.cluster),[0,1,0]);
 spans=[{start:0.1,end:0.9,speaker:0},{start:0.8,end:1.4,speaker:1},{start:2,end:2.8,speaker:0}];const unknown=inference.diarize(new Float32Array(48000));assert.equal(unknown.length,2);assert.equal(unknown[0].overlap,true);assert.equal(unknown[0].embedding,undefined);assert.equal(unknown[1].cluster,0);
}));

test('global voice library retains legacy consent until explicit account-wide confirmation',async()=>fixture(async({repo,record,input})=>{
  const registry=voiceprints(repo,{infer:async()=>({embedding:vector(0)})});await registry.enroll('owner','inbox',input);
  const legacy=(await registry.list('owner','all')),entry=legacy.entries[0],stored=(await repo.list('voiceprints')).find(bank=>bank.scope==='inbox');
  assert.equal(entry.global,false);const sealed=stored.entries[0].sealed;
  await repo.change(record.id,r=>{r.workspaceId=randomUUID();});
  assert.deepEqual(await registry.match('owner','all',input),{matches:[]});
  await assert.rejects(registry.confirmGlobal('owner',entry.id,{consent:false,libraryRevision:legacy.revision}),{code:'voiceprint_consent_required'});
  const confirmed=await registry.confirmGlobal('owner',entry.id,{consent:true,libraryRevision:legacy.revision});assert.equal(confirmed.entries[0].global,true);
  assert.equal((await repo.get(stored.id)).entries[0].sealed,sealed,'no copy or change to original AAD');
  assert.equal((await registry.match('owner','all',input)).matches[0].name,input.name);
  assert.deepEqual((await registry.list('other','all')).entries,[]);await assert.rejects(registry.match('other','all',input),{code:'record_not_found'});
  await registry.revoke('owner','all',entry.id,confirmed.revision);assert.deepEqual((await registry.list('owner','all')).entries,[]);assert.deepEqual(await registry.match('owner','all',input),{matches:[]});
}));

test('global identities distinguish duplicate legacy request IDs and revoke only the selected entry',async()=>fixture(async({repo,record,input})=>{
  const registry=voiceprints(repo,{infer:async()=>({embedding:vector(0)})});await registry.enroll('owner','inbox',input);
  const scope=randomUUID();await repo.change(record.id,r=>{r.workspaceId=scope;});await registry.enroll('owner',scope,{...input,name:'另一个条目'});
  const value=await registry.list('owner','all');assert.equal(value.entries.length,2);assert.equal(new Set(value.entries.map(e=>e.id)).size,2);
  await registry.revoke('owner','all',value.entries.find(e=>e.name===input.name).id,value.revision);assert.deepEqual((await registry.list('owner','all')).entries.map(e=>e.name),['另一个条目']);
}));

test('account-global enrollment matches across workspaces and cannot revive after an in-flight revoke',async()=>fixture(async({repo,record,input})=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const registry=voiceprints(repo,{infer:async()=>{entered();await gate;return {embedding:vector(0)};}});
  const pending=registry.enroll('owner','all',input),rejected=assert.rejects(pending,{code:'voiceprint_library_changed'});await ready;await registry.revoke('owner','all',input.requestId,0);release();await rejected;assert.deepEqual((await registry.list('owner','all')).entries,[]);
  const value=await registry.list('owner','all'),created=await registry.enroll('owner','all',{...input,libraryRevision:value.revision,requestId:randomUUID()});
  await repo.change(record.id,r=>{r.workspaceId=randomUUID();});assert.equal((await registry.match('owner','all',input)).matches[0].id,created.id);
}));

test('voice clips return bounded WAV through the owner route and reject stale retention or revisions',async()=>fixture(async({repo,record,input})=>{
  const registry=voiceprints(repo,{infer:async()=>({embedding:vector(0)})});await repo.change(record.id,r=>{r.retainAudio=true;});
  assert.equal((await registry.clip('owner',input)).length,96000);await assert.rejects(registry.clip('other',input),{code:'record_not_found'});await assert.rejects(registry.clip('owner',{...input,revision:999}),{code:'voiceprint_source_changed'});
  let headers,status,bytes;const path='/api/workspaces/all/voiceprints/clip';await workspaceRoutes({req:{method:'GET',url:path+'?'+new URLSearchParams({recordId:input.recordId,segmentId:input.segmentId,revision:String(input.revision)})},res:{writeHead:(code,value)=>{status=code;headers=value;},end:value=>{bytes=value;}},path,repo,user:{id:'owner'}});
  assert.equal(status,200);assert.equal(headers['Content-Type'],'audio/wav');assert.match(headers['Cache-Control'],/no-store/);assert.equal(headers['X-Content-Type-Options'],'nosniff');assert.equal(bytes.length,96044);assert.equal(bytes.toString('ascii',0,4),'RIFF');
  const read=repo.readAudio.bind(repo);let changed=false;repo.readAudio=async key=>{const data=await read(key);if(!changed){changed=true;await repo.change(record.id,r=>{r.audioCleanup={};});}return data;};await assert.rejects(registry.clip('owner',input),{code:'voiceprint_audio_unavailable'});
}));

test('revoking a library entry during playback prevents its buffered clip from being returned',async()=>fixture(async({repo,record,input})=>{
  const registry=voiceprints(repo,{infer:async()=>({embedding:vector(0)})});const entry=await registry.enroll('owner','all',input);await repo.change(record.id,r=>{r.retainAudio=true;});const state=await registry.list('owner','all'),read=repo.readAudio.bind(repo);let changed=false;
  repo.readAudio=async key=>{const data=await read(key);if(!changed){changed=true;await registry.revoke('owner','all',entry.id,state.revision);}return data;};
  await assert.rejects(registry.clip('owner',{id:entry.id}),{code:'voiceprint_not_found'});assert.deepEqual((await registry.list('owner','all')).entries,[]);
}));

test('global matching rechecks legacy consent against a workspace changed during inference',async()=>fixture(async({repo,record,input})=>{
  let moving=false;const registry=voiceprints(repo,{infer:async()=>{if(moving)await repo.change(record.id,r=>{r.workspaceId=randomUUID();});return {embedding:vector(0)};}});
  await registry.enroll('owner','inbox',input);moving=true;assert.deepEqual(await registry.match('owner','all',input),{matches:[]});
  const state=await registry.list('owner','all');await registry.confirmGlobal('owner',state.entries[0].id,{consent:true,libraryRevision:state.revision});assert.equal((await registry.match('owner','all',input)).matches.length,1);
}));

test('global unknown revocation fences an older scoped enrollment still inferring',async()=>fixture(async({input,repo})=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const registry=voiceprints(repo,{infer:async()=>{entered();await held;return {embedding:vector(0)};}}),pending=registry.enroll('owner','inbox',input),rejected=assert.rejects(pending,{code:'voiceprint_library_changed'});
  await ready;const state=await registry.list('owner','all');await registry.revoke('owner','all',input.requestId,state.revision);release();await rejected;assert.deepEqual((await registry.list('owner','all')).entries,[]);
}));

test('a global revoke during the first bank creation also fences a legacy enrollment',async()=>fixture(async({repo,input})=>{
  const registry=voiceprints(repo,{infer:async()=>({embedding:vector(0)})}),insert=repo.insert.bind(repo);let entered,release,intercepted=false;const ready=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  repo.insert=async value=>{if(value.kind==='voiceprints'&&!intercepted){intercepted=true;entered();await held;}return insert(value);};
  const pending=registry.enroll('owner','inbox',input),rejected=assert.rejects(pending,{code:'voiceprint_library_changed'});await ready;await registry.revoke('owner','all',input.requestId,0);release();await rejected;assert.deepEqual((await registry.list('owner','all')).entries,[]);
}));


test('short speech can save a name without waiting for a usable voice clip',()=>fixture(async({repo,record,segment})=>{
  let calls=0;const library=voiceprints(repo,{infer:async()=>{calls++;return {embedding:vector(0)};}}),service=voiceLearning(repo,{library}),personId=randomUUID();
  await repo.change(record.id,r=>{r.segments[0].endMs=1000;r.segments[0].speakerId='local-a';});
  const updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:personId,name:'林工'});
  assert.equal(updated.segments[0].speaker,'林工');assert.equal(updated.segments[0].speakerConfirmed,true);
  const input={recordId:record.id,segmentId:segment.id,revision:updated.segments[0].revision,personId,requestId:randomUUID(),consent:true};
  assert.equal((await service.learn('owner',input)).status,'waiting');assert.equal(calls,0);
  await repo.change(record.id,r=>{r.segments.push({...r.segments[0],id:randomUUID(),endMs:3000});});
  await service.run();assert.equal((await repo.get(input.requestId)).status,'ready');assert.equal(calls,1);
  await assert.rejects(service.learn('other',input),{code:'voiceprint_not_found'});
}));

test('voice learning is queued independently, supports multiple people and survives a worker restart',()=>fixture(async({repo,record,segment})=>{
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const library=voiceprints(repo,{infer:async()=>{started();await gate;return {embedding:vector(0)};}}),service=voiceLearning(repo,{library}),personId=randomUUID();
  const updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:personId,name:'林工'});
  await service.savePerson('owner',{id:randomUUID(),name:'陈老师'});
  const input={recordId:record.id,segmentId:segment.id,revision:updated.segments[0].revision,personId,requestId:randomUUID(),consent:true};
  assert.equal((await service.learn('owner',input)).status,'queued');
  assert.equal((await service.learn('owner',input)).status,'queued');
  const running=voiceLearning(repo,{library}).run();await entered;
  assert.equal((await repo.get(record.id)).segments[0].speaker,'林工');
  assert.equal((await service.people('owner')).people.length,2);
  release();await running;
  assert.equal((await repo.get(input.requestId)).status,'ready');
  assert.equal((await service.people('owner')).people.find(person=>person.id===personId).samples,1);
  await service.run();assert.equal((await library.list('owner','all')).entries.length,1);
}));

test('deleting a person while embedding runs cannot resurrect a voice',()=>fixture(async({repo,record,segment})=>{
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const library=voiceprints(repo,{infer:async()=>{started();await gate;return {embedding:vector(0)};}}),service=voiceLearning(repo,{library}),personId=randomUUID();
  const updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:personId,name:'林工'});
  const input={recordId:record.id,segmentId:segment.id,revision:updated.segments[0].revision,personId,requestId:randomUUID(),consent:true};
  await service.learn('owner',input);const running=service.run();await entered;await service.remove('owner',personId);release();await running;
  assert.equal((await repo.get(input.requestId)).status,'failed');assert.equal((await library.list('owner','all')).entries.length,0);
}));

test('future meeting matching preserves human names and rejects ambiguous candidates',()=>fixture(async({repo,segment,input})=>{
  const library=voiceprints(repo,{infer:async()=>({embedding:vector(0)})}),service=voiceLearning(repo,{library}),personId=randomUUID();
  await service.savePerson('owner',{id:personId,name:'林工'});
  const entry=await library.enroll('owner','all',{...input,personId});
  const future=createRecord('owner');future.capture='completed';future.transcriptRevision=1;future.voiceMatch={status:'queued'};
  future.segments=[{...segment,id:randomUUID(),speakerId:'a',speaker:'说话人 1',edited:false},{...segment,id:randomUUID(),speakerId:'a',speaker:'手工称谓',speakerConfirmed:true,edited:true}];await repo.insert(future);
  assert.ok((await repo.listWork({lane:'voiceprints'})).some(row=>row.id===future.id));
  const matcher=voiceLearning(repo,{library:{...library,match:async()=>({matches:[{...entry,personId,similarity:0.95}]})}});
  await matcher.matchRecord(future);const matched=await repo.get(future.id);
  assert.equal(matched.segments[0].speaker,'林工');assert.equal(matched.segments[0].speakerMatch,'automatic');assert.equal(matched.segments[1].speaker,'手工称谓');
  const other=createRecord('owner');other.capture='completed';other.transcriptRevision=1;other.voiceMatch={status:'queued'};other.segments=[{...segment,id:randomUUID(),speakerId:'b',speaker:'说话人 2',edited:false}];await repo.insert(other);
  await voiceLearning(repo,{library:{...library,match:async()=>({matches:[{...entry,personId,similarity:0.89},{id:randomUUID(),similarity:0.85}]})}}).matchRecord(other);
  assert.equal((await repo.get(other.id)).segments[0].speaker,'说话人 2');
}));


test('correcting a learned speaker invalidates only that source in the old person',()=>fixture(async({repo,record,segment})=>{
 const library=voiceprints(repo,{infer:async()=>({embedding:vector(0)})}),service=voiceLearning(repo,{library}),first=randomUUID(),second=randomUUID();
 let updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:first,name:'林工'});
 const job={recordId:record.id,segmentId:segment.id,revision:updated.segments[0].revision,personId:first,requestId:randomUUID(),consent:true};
 await service.learn('owner',job);await service.run();assert.equal((await library.list('owner','all')).entries.length,1);
 updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:updated.segments[0].revision,requestId:second,name:'陈老师'});
 assert.equal(updated.segments[0].speaker,'陈老师');assert.equal((await library.list('owner','all')).entries.length,0);
 assert.equal((await service.people('owner')).people.find(person=>person.id===first).samples,0);
}));

test('relabeling while a voice learns cancels its frozen original authorization',()=>fixture(async({repo,record,segment})=>{
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const library=voiceprints(repo,{infer:async()=>{entered();await gate;return {embedding:vector(0)};}}),service=voiceLearning(repo,{library}),first=randomUUID();
 const updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:first,name:'林工'});
 const job={recordId:record.id,segmentId:segment.id,revision:updated.segments[0].revision,personId:first,requestId:randomUUID(),consent:true};
 await service.learn('owner',job);const running=service.run();await started;
 await service.annotate('owner',record.id,{segmentId:segment.id,revision:updated.segments[0].revision,requestId:randomUUID(),name:'陈老师'});
 release();await running;assert.equal((await repo.get(job.requestId)).status,'cancelled');assert.equal((await library.list('owner','all')).entries.length,0);
}));

test('waiting cannot borrow another clip after its original name was corrected',()=>fixture(async({repo,record,segment})=>{
 const library=voiceprints(repo,{infer:async()=>assert.fail('revoked waiting consent must not infer')}),service=voiceLearning(repo,{library}),first=randomUUID();
 await repo.change(record.id,r=>{r.segments[0].endMs=1000;r.segments[0].speakerId='a';});
 const updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:first,name:'林工'});
 const job={recordId:record.id,segmentId:segment.id,revision:updated.segments[0].revision,personId:first,requestId:randomUUID(),consent:true};await service.learn('owner',job);
 await repo.change(record.id,r=>{r.segments.push({...r.segments[0],id:randomUUID(),endMs:3000});});
 await service.annotate('owner',record.id,{segmentId:segment.id,revision:updated.segments[0].revision,requestId:randomUUID(),name:'陈老师'});
 await service.run();assert.equal((await repo.get(job.requestId)).status,'cancelled');
}));


test('audio cleanup gives pending speaker matching a bounded processing window',()=>{
 const record=createRecord('owner',{retainAudio:false});record.capture='completed';record.voiceMatch={status:'queued',expiresAt:Date.now()+180000};
 assert.equal(audioPurgeReady(record),false);record.voiceMatch.expiresAt=Date.now()-1;assert.equal(audioPurgeReady(record),true);
});


test('correcting a short authorizing turn also revokes its learned substitute clip',()=>fixture(async({repo,record,segment})=>{
 const library=voiceprints(repo,{infer:async()=>({embedding:vector(0)})}),service=voiceLearning(repo,{library}),first=randomUUID(),longId=randomUUID();
 await repo.change(record.id,r=>{r.segments[0].speakerId='a';r.segments[0].endMs=1000;r.segments.push({...r.segments[0],id:longId,endMs:3000});});
 const updated=await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:first,name:'林工'}),short=updated.segments.find(s=>s.id===segment.id);
 const job={recordId:record.id,segmentId:segment.id,revision:short.revision,personId:first,requestId:randomUUID(),consent:true};await service.learn('owner',job);await service.run();
 const saved=(await library.list('owner','all')).entries;assert.equal(saved.length,1);assert.equal(saved[0].source.segmentId,longId);
 await service.annotate('owner',record.id,{segmentId:segment.id,revision:short.revision,requestId:randomUUID(),name:'陈老师'});
 assert.equal((await library.list('owner','all')).entries.length,0);assert.equal((await repo.get(record.id)).segments.find(s=>s.id===longId).speaker,'林工');
}));

test('saving a speaker name keeps completed minutes current and does not restart meeting wrap-up',()=>fixture(async({repo,record,segment})=>{
  const {automaticMinutesAt}=await import('../packages/records/src/automation.mjs');
  await repo.change(record.id,r=>{
    r.capture='completed';r.transcription='ready';r.autoMinutes={enabled:true,intervalSeconds:90,enabledAt:Date.now()-100000,lastRequestedAt:Date.now()-100000};
    const evidence=[{segmentId:segment.id,revision:segment.revision}];
    r.minutesRevision=1;r.minutes={revision:1,transcriptRevision:r.transcriptRevision,notesRevision:r.notesRevision,sections:[{heading:'已确认纪要',items:[{text:'保留已整理的内容',evidence}]}],evidenceSnapshot:[{...r.segments[0]}]};
    r.jobs=[{id:randomUUID(),status:'completed',scope:'final',mode:'model',transcriptRevision:r.transcriptRevision,notesRevision:r.notesRevision,createdAt:new Date().toISOString()}];
  });
  assert.equal(automaticMinutesAt(await repo.get(record.id)),Infinity);
  const service=voiceLearning(repo,{library:voiceprints(repo,{infer:async()=>assert.fail('renaming must not infer voices')})});
  await service.annotate('owner',record.id,{segmentId:segment.id,revision:segment.revision,requestId:randomUUID(),name:'林工'});
  const current=await repo.get(record.id);
  assert.equal(automaticMinutesAt(current),Infinity,'a name change must not schedule the same meeting again');
  assert.equal(current.minutes.transcriptRevision,current.transcriptRevision);
  assert.equal(current.minutes.sections[0].items[0].text,'保留已整理的内容');
  assert.equal(current.minutes.evidenceSnapshot[0].speaker,'林工');
}));

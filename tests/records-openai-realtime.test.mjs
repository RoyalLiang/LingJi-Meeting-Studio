import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { openRealtime, pcm24k } from '../services/records/src/openai-realtime.mjs';
import { processRealtimeAudio, generateRealtimeMinutes, closeRealtime, reconcileRealtime } from '../services/records/src/realtime-minutes.mjs';
import { buildMinutesManifest } from '../services/records/src/minutes-pipeline.mjs';
import { normalizeConfig, publicConfig, saveConfig, readConfig } from '../services/records/src/config.mjs';
import { providerStatus } from '../services/records/src/providers.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { runCycle } from '../services/records/src/worker.mjs';
import { createRecord, addSource, acknowledge, seal, digest, requestMinutes, editSegment } from '../packages/records/src/record.mjs';
import { createRecordServer } from '../services/records/src/server.mjs';

async function temporary(work) {
  const root = await mkdtemp(join(tmpdir(), 'lingji-realtime-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function fixture(work, responseHook) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const state = { connections: 0, pcm: [], events: [], requests: [] };
  server.on('connection', (socket, request) => {
    state.connections++;
    assert.equal(request.headers.authorization, 'Bearer fixture-key');
    assert.equal(new URL(request.url, 'http://local').searchParams.get('model'), 'fixture-realtime');
    let index = 0;
    socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
    socket.on('message', async data => {
      const event = JSON.parse(data); state.events.push(event);
      if (event.type === 'session.update') {
        assert.equal(event.session.type, 'realtime');
        assert.deepEqual(event.session.output_modalities, ['text']);
        assert.equal(event.session.audio.input.format.rate, 24000);
        assert.equal(event.session.audio.input.turn_detection, null);
        socket.send(JSON.stringify({ type: 'session.updated' }));
      } else if (event.type === 'input_audio_buffer.append') state.pcm.push(Buffer.from(event.audio, 'base64'));
      else if (event.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: `audio-${state.connections}-${++index}` }));
      else if (event.type === 'response.create') {
        state.requests.push(event);
        if (responseHook) { await responseHook(socket, event); return; }
        const payload = event.response.input.find(item => item.type === 'message');
        const input = JSON.parse(payload.content[0].text), refs = input.transcript || [];
        const evidence = refs.map(segment => ({ segmentId: segment.id, revision: segment.revision }));
        const result = refs.length ? { title: '音频会议纪要', topics: [{ id: 'delivery', title: '交付', summary: '核对交付安排', evidence }], sections: [{ heading: '讨论', items: refs.map(segment => ({ text: `核对事项 ${segment.id}`, evidence: [{segmentId:segment.id,revision:segment.revision}] })) }], actions: [] } : { ok: true };
        const text = JSON.stringify(result), split = Math.floor(text.length / 2);
        for (const delta of [text.slice(0,split), text.slice(split)]) socket.send(JSON.stringify({ type: 'response.output_text.delta', delta }));
        socket.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } }));
      }
    });
  });
  const config = normalizeConfig({ MINUTES_MODE: 'openai-realtime', OPENAI_REALTIME_URL: `ws://127.0.0.1:${server.address().port}/v1/realtime?route=meeting`, OPENAI_REALTIME_MODEL: 'fixture-realtime', OPENAI_REALTIME_API_KEY: 'fixture-key', NODE_ENV: 'test' });
  try { await work(config, state); }
  finally { server.clients.forEach(socket => socket.terminate()); await new Promise(resolve => server.close(resolve)); }
}

async function recorded(repo, config, { consent = true, seconds = 1, retainAudio = true } = {}) {
  await saveConfig(repo.root, config, {NODE_ENV:'test'});
  const record = createRecord('fixture-owner', {autoMinutes:true,realtimeAudioConsent:consent,retainAudio});
  const mic = addSource(record, {kind:'microphone'}), system = addSource(record, {kind:'display'});
  await repo.insert(record);
  const bytes = Buffer.alloc(16000 * seconds * 2, 3);
  for (const source of [mic,system]) {
    const object = await repo.putAudio(record.id, bytes);
    await repo.change(record.id, current => acknowledge(current, { sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence:0,sampleOffset:0,sampleCount:bytes.length/2,sampleRate:16000,digest:digest(bytes),...object }));
  }
  return { record: await repo.get(record.id), bytes, sources:[mic,system] };
}

test('Realtime is opt-in, stores a separate secret and validates WebSocket endpoints', async () => temporary(async root => {
  assert.equal(normalizeConfig({}).MINUTES_MODE, 'asr-llm');
  await saveConfig(root, {MINUTES_MODE:'openai-realtime',OPENAI_REALTIME_API_KEY:'fixture-key'}, {NODE_ENV:'test'});
  const config = await readConfig(root, {});
  assert.equal(providerStatus(config).minutes, true);
  assert.equal(providerStatus(config).textMinutes, false);
  assert.equal(publicConfig(config).OPENAI_REALTIME_API_KEY, true);
  assert.equal(JSON.stringify(publicConfig(config)).includes('fixture-key'), false);
  await saveConfig(root, {OPENAI_REALTIME_API_KEY:''}, {});
  assert.equal((await readConfig(root, {})).OPENAI_REALTIME_API_KEY, 'fixture-key');
  await assert.rejects(saveConfig(root, {OPENAI_REALTIME_URL:'https://example.test/v1/responses'}, {NODE_ENV:'production'}), /invalid_provider_url/);
  await assert.rejects(saveConfig(root, {MINUTES_MODE:'automatic'}, {}), /invalid_minutes_mode/);
}));

test('PCM16 16kHz audio is converted to signed little-endian 24kHz', () => {
  const bytes = Buffer.alloc(8); [0,3000,-3000,0].forEach((sample,index) => bytes.writeInt16LE(sample,index*2));
  const result = pcm24k(bytes);
  assert.equal(result.length, 12);
  assert.deepEqual(Array.from({length:6},(_,i)=>result.readInt16LE(i*2)), [0,2000,1000,-3000,-1000,0]);
  assert.throws(() => pcm24k(Buffer.alloc(3)), /invalid_realtime_audio/);
});

test('audio reaches Realtime before ASR and dual-source final minutes retain frozen evidence', async () => fixture(async (config,state) => temporary(async root => {
  const repo = await createRepository({root,databaseUrl:''});
  try {
    const {record,bytes,sources} = await recorded(repo,config);
    await runCycle(repo, {}, {lane:'realtime'});
    let current = await repo.get(record.id);
    assert.equal(current.segments.length, 0);
    assert.ok(current.chunks.every(chunk => chunk.state === 'pending'));
    assert.equal(current.realtime.state, 'listening');
    assert.equal(state.pcm.length, 2);
    assert.equal(state.pcm[0].length, bytes.length * 1.5);
    await repo.change(record.id,r => seal(r,sources.map(source => ({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,lastSequence:0}))));
    await runCycle(repo, {transcribe: async () => '周五核对交付安排。'}, {lane:'audio'});
    current = await repo.get(record.id);
    assert.equal(current.capture, 'completed');
    assert.equal(current.segments.length, 2);
    await repo.change(record.id,r => requestMinutes(r,{mode:'model'}));
    await runCycle(repo, {}, {lane:'minutes'});
    current = await repo.get(record.id);
    assert.equal(current.jobs.at(-1).status, 'completed');
    assert.equal(current.minutes.runtime.protocol, 'openai-realtime');
    assert.equal(current.minutes.evidenceSnapshot.length, 2);
    assert.equal(current.minutes.sections[0].items.length, 2);
    assert.equal(current.usage.llmTokens, 60);
    assert.equal(state.requests[0].response.conversation, 'none');
    assert.equal(state.requests[0].response.input.filter(item => item.type === 'item_reference').length, 1);
    assert.equal(state.requests.length, 3);
    assert.deepEqual(await repo.readAudio(current.chunks[0].object), bytes);
  } finally { closeRealtime(repo); await repo.close(); }
})));

test('pre-existing ASR consent never silently enables raw-audio transmission', async () => fixture(async (config,state) => temporary(async root => {
  const repo = await createRepository({root,databaseUrl:''});
  try {
    const {record} = await recorded(repo,config,{consent:false});
    await processRealtimeAudio(repo,record,config);
    assert.equal(state.connections, 0);
    await assert.rejects(generateRealtimeMinutes(repo,record.id,{generation:record.generation,snapshot:[]},config), /realtime_audio_consent_required/);
  } finally { closeRealtime(repo); await repo.close(); }
})));

test('response failures are explicit and unfinished JSON is never accepted', async () => fixture(async config => {
  const client = openRealtime(config);
  try { await client.ready; await assert.rejects(client.respond([], 'Return JSON.', {timeoutMs:1000}), /realtime_response_incomplete/); }
  finally { client.close(); }
}, socket => socket.send(JSON.stringify({type:'response.done',response:{status:'failed',output:[]}}))));

test('closed Realtime sessions replay durable audio into a fresh session', async () => fixture(async (config,state) => temporary(async root => {
  const repo = await createRepository({root,databaseUrl:''});
  try {
    const {record} = await recorded(repo,config);
    await processRealtimeAudio(repo,record,config);
    closeRealtime(repo,record.id);
    await processRealtimeAudio(repo,await repo.get(record.id),config);
    assert.equal(state.connections, 2);
    assert.equal(state.pcm.length, 4);
    assert.equal((await repo.get(record.id)).usage.samples, 32000);
  } finally { closeRealtime(repo); await repo.close(); }
})));

test('five-minute sessions rotate with bounded replay and close when authorization is withdrawn', async () => fixture(async (config,state) => temporary(async root => {
  const repo=await createRepository({root,databaseUrl:''}),clock=Date.now;
  try {
    const {record}=await recorded(repo,config);
    await processRealtimeAudio(repo,record,config);
    const after=clock()+5*60*1000+1;
    Date.now=()=>after;
    await reconcileRealtime(repo,config);
    await processRealtimeAudio(repo,await repo.get(record.id),config);
    assert.equal(state.connections,2);
    assert.equal(state.pcm.length,4);
    await repo.change(record.id,r=>{r.autoMinutes.enabled=false;});
    await reconcileRealtime(repo,config);
    await processRealtimeAudio(repo,await repo.get(record.id),config);
    assert.equal(state.connections,2);
  } finally {Date.now=clock;closeRealtime(repo);await repo.close();}
})));

test('provider failures preserve ASR work, schedule bounded recovery and never mark audio delivered', async () => temporary(async root => {
  const repo=await createRepository({root,databaseUrl:''});
  const config=normalizeConfig({MINUTES_MODE:'openai-realtime',OPENAI_REALTIME_API_KEY:'fixture-key'});
  let connections=0;
  const factory=()=>{connections++;return {ready:Promise.resolve(),audio:async()=>{throw Object.assign(new Error('offline'),{code:'realtime_connection_failed'});},close(){}};};
  try {
    const {record}=await recorded(repo,config);
    await processRealtimeAudio(repo,record,config,factory);
    const current=await repo.get(record.id);
    assert.equal(current.realtime.state,'blocked');
    assert.equal(current.realtime.audioThroughMs,undefined);
    assert.equal(current.transcriptRevision,0);
    assert.ok(current.chunks.every(chunk=>chunk.state==='pending'));
    assert.ok(current.nextWorkAt<=current.realtime.retryAt);
    await processRealtimeAudio(repo,current,config,factory);
    assert.equal(connections,1);
  } finally {closeRealtime(repo);await repo.close();}
}));

test('Realtime usage is retained even when a billable response fails', async () => fixture(async config => {
  const client=openRealtime(config);let usage;
  try {await assert.rejects(client.respond([],'Return JSON.',{onUsage:value=>{usage=value;}}),/realtime_response_incomplete/);assert.deepEqual(usage,{totalTokens:7});}
  finally {client.close();}
},socket=>socket.send(JSON.stringify({type:'response.done',response:{status:'failed',usage:{total_tokens:7}}}))));

test('minute window caches cannot cross ASR/LLM and Realtime modes', () => {
  const job={generation:1,transcriptRevision:1,snapshot:[{id:'s',revision:1,text:'事项',sourceId:'mic',startMs:0,endMs:1000}],notes:'',notesRevision:0,modelVersion:'default'};
  const original=buildMinutesManifest(job,normalizeConfig({LLM_MODEL:'text-model'}));
  const realtime=buildMinutesManifest(job,normalizeConfig({MINUTES_MODE:'openai-realtime',LLM_MODEL:'text-model'}));
  assert.notEqual(original.policy,realtime.policy);
  assert.notEqual(original.windows[0].key,realtime.windows[0].key);
});

test('temporary original audio survives ASR until Realtime final minutes finish', async () => fixture(async config => temporary(async root => {
  const repo=await createRepository({root,databaseUrl:''});
  try {
    const {record,sources,bytes}=await recorded(repo,config,{retainAudio:false});
    await repo.change(record.id,r=>seal(r,sources.map(source=>({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,lastSequence:0}))));
    await runCycle(repo,{transcribe:async()=> '收尾结论'}, {lane:'audio'});
    let current=await repo.get(record.id);
    assert.equal(Boolean(current.audioPurged),false);
    assert.deepEqual(await repo.readAudio(current.chunks[0].object),bytes);
    await repo.change(record.id,r=>requestMinutes(r,{mode:'model'}));
    await runCycle(repo,{}, {lane:'minutes'});
    assert.equal((await repo.get(record.id)).jobs.at(-1).status,'completed');
    await runCycle(repo,{}, {lane:'audio'});
    current=await repo.get(record.id);
    assert.equal(current.audioPurged,true);
  } finally {closeRealtime(repo);await repo.close();}
})));

test('completed capture cannot close an in-flight final response', async () => temporary(async root => {
  const repo=await createRepository({root,databaseUrl:''}),config=normalizeConfig({MINUTES_MODE:'openai-realtime',OPENAI_REALTIME_API_KEY:'fixture-key'});
  let release,started,closed=false;const entered=new Promise(resolve=>{started=resolve;});
  const factory=()=>({ready:Promise.resolve(),audio:async()=> 'audio-item',respond:async()=>{started();await new Promise(resolve=>{release=resolve;});assert.equal(closed,false);const current=await repo.get(record.id);return {title:'终稿',sections:[{heading:'讨论',items:[{text:'结论',evidence:[{segmentId:current.segments[0].id,revision:1}]}]}],actions:[]};},close(){closed=true;}});
  const {record,sources}=await recorded(repo,config);
  try {
    await processRealtimeAudio(repo,record,config,factory);
    await repo.change(record.id,r=>seal(r,sources.map(source=>({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,lastSequence:0}))));
    await runCycle(repo,{transcribe:async()=> '结论'}, {lane:'audio'});
    const current=await repo.get(record.id),pending=generateRealtimeMinutes(repo,record.id,{generation:record.generation,snapshot:current.segments,scope:'final'},config,{},factory);
    await entered;
    await processRealtimeAudio(repo,current,config,factory);
    assert.equal(closed,false);
    release();await pending;
  } finally {release?.();closeRealtime(repo);await repo.close();}
}));

test('overlapping sources and long ASR turns use bounded independent audio windows', () => {
  const snapshot=['mic','system','extra'].map(id=>({id,revision:1,text:'两分钟发言',sourceId:id,startMs:0,endMs:120000}));
  snapshot.push({id:'long',revision:1,text:'长发言',sourceId:'mic',startMs:120000,endMs:840000});
  const manifest=buildMinutesManifest({generation:1,transcriptRevision:1,snapshot,notes:'',notesRevision:0},normalizeConfig({MINUTES_MODE:'openai-realtime'}));
  assert.equal(manifest.windows.length,9);
  for(const window of manifest.windows) {
    assert.equal(new Set(window.snapshot.map(segment=>segment.sourceId)).size,1);
    assert.ok(window.snapshot.every(segment=>segment.endMs-segment.startMs<=120000));
  }
  assert.deepEqual([...new Set(manifest.windows.flatMap(window=>window.snapshot.map(segment=>segment.id)))].sort(),['extra','long','mic','system']);
});

test('a late audio summary cannot overwrite a revised transcript', async () => {
  let revise, revisionWork;
  await fixture(async config => temporary(async root => {
    const repo = await createRepository({root,databaseUrl:''});
    try {
      const {record,sources} = await recorded(repo,config);
      await repo.change(record.id,r => seal(r,sources.map(source=>({sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,lastSequence:0}))));
      await runCycle(repo,{transcribe:async()=> '原稿'}, {lane:'audio'});
      await repo.change(record.id,r=>requestMinutes(r,{mode:'model'}));
      revise = () => revisionWork ||= repo.change(record.id,r=>editSegment(r,r.segments[0].id,{revision:1,text:'人工纠正的原稿'}));
      await runCycle(repo,{}, {lane:'minutes'});
      const current=await repo.get(record.id);
      assert.equal(current.minutes, null);
      assert.ok(['stale','failed'].includes(current.jobs.at(-1).status));
      assert.equal(current.segments[0].text,'人工纠正的原稿');
    } finally {closeRealtime(repo);await repo.close();}
  }),async (socket,event)=>{
    const input=JSON.parse(event.response.input.find(item=>item.type==='message').content[0].text),segment=input.transcript[0];
    await revise();
    socket.send(JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify({title:'旧音频结果',sections:[{heading:'讨论',items:[{text:'旧结论',evidence:[{segmentId:segment.id,revision:segment.revision}]}]}],actions:[]})}));
    socket.send(JSON.stringify({type:'response.done',response:{status:'completed'}}));
  });
});

test('three-hour dual-source timelines and retransmissions have no two-hour quota', () => {
  const record=createRecord('long-meeting'),sources=[addSource(record,{kind:'microphone'}),addSource(record,{kind:'display'})];
  for(let sequence=0;sequence<720;sequence++)for(const source of sources)acknowledge(record,{sessionId:source.sessionId,sourceId:source.id,epoch:source.epoch,sequence,sampleOffset:sequence*240000,sampleCount:240000,sampleRate:16000,digest:'fixture',object:'fixture'});
  assert.equal(record.usage.samples,16000*3*60*60*2);
  const samples=record.usage.samples,chunk=record.chunks.at(-1);
  acknowledge(record,chunk);
  assert.equal(record.usage.samples,samples);
  assert.equal(record.sources[0].watermark,719);
  assert.equal((chunk.sampleOffset+chunk.sampleCount)/16000,10800);
});

test('HTTP bootstrap removes the advertised cap and requires separate raw-audio consent', async () => temporary(async root => {
  await saveConfig(root,{MINUTES_MODE:'openai-realtime',OPENAI_REALTIME_API_KEY:'fixture-key'}, {NODE_ENV:'test'});
  const app=await createRecordServer({root,databaseUrl:'',port:0}),address=await app.start(),base=`http://127.0.0.1:${address.port}`;
  try {
    const login=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'realtime@example.test',password:'long-password'})}),user=await login.json();
    const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf};
    const boot=await (await fetch(base+'/api/bootstrap',{headers})).json();
    assert.equal(boot.limits.maxMinutes,null);
    assert.equal(boot.providers.minutesMode,'openai-realtime');
    const denied=await fetch(base+'/api/records',{method:'POST',headers,body:JSON.stringify({autoMinutes:true})});
    assert.equal(denied.status,403);
    const allowed=await fetch(base+'/api/records',{method:'POST',headers,body:JSON.stringify({autoMinutes:true,realtimeAudioConsent:true})});
    assert.equal(allowed.status,201);
    assert.equal((await allowed.json()).realtimeAudioConsent,true);
  } finally {await app.stop();}
}));

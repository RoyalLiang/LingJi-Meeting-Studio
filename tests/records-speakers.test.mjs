import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { gzipSync,gunzipSync } from 'node:zlib';
import { createRecord,addSource,acknowledge,seal,editSegment,publicRecord } from '../packages/records/src/record.mjs';
import { commitSpeakerTurns,finishSpeakerSource,updateTranscriptPreview,speakerHash } from '../packages/records/src/speakers.mjs';
import { createRepository } from '../services/records/src/repository.mjs';
import { processSpeakerSources,closeSpeakerStreams } from '../services/records/src/speaker-streams.mjs';
import { createDoubaoSpeakerStream } from '../services/records/src/doubao.mjs';
const wait=()=>new Promise(r=>setTimeout(r,5));
function fixture(){const r=createRecord('owner',{retainAudio:true}),s=addSource(r,{kind:'microphone',label:'测试音轨'});for(let i=0;i<3;i++)acknowledge(r,{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence:i,sampleOffset:i*3200,sampleCount:3200,sampleRate:16000,digest:`digest${i}`,object:`object${i}`});s.asr={fence:'one',speakerMap:{},mayAllocate:true};return {r,s};}
const turns=[{text:'甲第一次发言',startMs:0,endMs:200,speakerId:'0'},{text:'乙发言',startMs:200,endMs:400,speakerId:'1'},{text:'甲再次发言',startMs:400,endMs:600,speakerId:'0'}];
test('a silent first shared source cannot prevent the first audible microphone from allocating speaker identities',()=>{
  const {r,s}=fixture();s.kind='display';r.speakerOriginSourceId=s.id;
  const microphone=addSource(r,{kind:'microphone',label:'真实麦克风'});
  acknowledge(r,{sessionId:microphone.sessionId,sourceId:microphone.id,epoch:microphone.epoch,sequence:0,sampleOffset:0,sampleCount:9600,sampleRate:16000,digest:'microphone-digest',object:'microphone-object'});
  microphone.asr={fence:'microphone',speakerMap:{},mayAllocate:false};
  commitSpeakerTurns(r,microphone.id,'microphone',turns,r.generation);
  assert.deepEqual(r.segments.map(segment=>segment.speaker),['说话人 1','说话人 2','说话人 1']);
  assert.equal(r.speakerOriginSourceId,microphone.id);
  assert.equal(s.asr.mayAllocate,false);
});
test('A-B-A reuses numbered acoustic identities including vendor zero; replay is idempotent',()=>{const {r,s}=fixture();commitSpeakerTurns(r,s.id,'one',turns,1);assert.deepEqual(r.segments.map(s=>s.speaker),['说话人 1','说话人 2','说话人 1']);const rev=r.transcriptRevision;commitSpeakerTurns(r,s.id,'one',turns,1);assert.equal(r.transcriptRevision,rev);assert.equal(r.speakers.length,2);});
test('reconnection replays audio anchors even when vendor IDs swap; manual edits survive',()=>{const {r,s}=fixture();commitSpeakerTurns(r,s.id,'one',turns,1);editSegment(r,r.segments[0].id,{revision:1,text:'人工文字',speaker:'甲'});s.asr={fence:'two',speakerMap:{},mayAllocate:false};commitSpeakerTurns(r,s.id,'two',turns.map(t=>({...t,speakerId:t.speakerId==='0'?'1':'0'})),1);assert.deepEqual(r.segments.map(s=>s.speaker),['甲','说话人 2','说话人 1']);assert.equal(r.segments.length,3);assert.equal(r.segments[0].text,'人工文字');assert.equal(r.speakers.length,2);});
test('speaker count is bounded; missing, excess and unrelated connection identities remain unconfirmed',()=>{const {r,s}=fixture();r.chunks[2].sampleCount=16000;const many=Array.from({length:12},(_,i)=>({text:`句子${i}`,startMs:i*100,endMs:(i+1)*100,speakerId:String(i)}));commitSpeakerTurns(r,s.id,'one',many,1);assert.equal(r.speakers.length,10);assert.equal(r.segments.at(-1).speaker,'');const source=addSource(r,{kind:'microphone'});source.asr={fence:'other',speakerMap:{},mayAllocate:false};r.chunks.push({...r.chunks[0],sourceId:source.id});commitSpeakerTurns(r,source.id,'other',[turns[0]],1);assert.equal(r.segments.at(-1).speaker,'');assert.equal(r.speakers.length,10);});
test('source completion requires sealed contiguous audio, final server ack and a current ownership fence',()=>{const {r,s}=fixture();s.asr.ended=true;assert.equal(finishSpeakerSource(r,s.id,'stale',1),false);assert.equal(finishSpeakerSource(r,s.id,'one',1),false);seal(r,[{sourceId:s.id,epoch:s.epoch,lastSequence:2}]);finishSpeakerSource(r,s.id,'one',1);assert.equal(r.capture,'completed');assert.ok(r.chunks.every(c=>c.state==='done'));});
function response(utterances,final=false){const payload=gzipSync(Buffer.from(JSON.stringify({result:{text:utterances.map(u=>u.text).join(''),utterances}}))),sequence=Buffer.alloc(4),size=Buffer.alloc(4);sequence.writeInt32BE(final?-1:1);size.writeUInt32BE(payload.length);return Buffer.concat([Buffer.from([0x11,final?0x93:0x91,0x11,0]),sequence,size,payload]);}
test('continuous vendor socket yields live A-B-A across chunks and drains once, never one connection per chunk',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-speakers-')),repo=await createRepository({root}),server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>server.once('listening',r));let connections=0,packets=0,tails=0;
 server.on('connection',socket=>{connections++;socket.on('message',frame=>{if(frame[1]>>4===1){const init=JSON.parse(gunzipSync(frame.subarray(8)));assert.equal(init.request.enable_speaker_info,true);assert.equal(init.request.enable_nonstream,true);assert.equal(init.request.ssd_version,'200');}else if(frame[1]&2){tails++;socket.send(response(turns.map(t=>({text:t.text,...(t.startMs ? {start_time:t.startMs} : {}),end_time:t.endMs,definite:true,additions:{speaker_id:t.speakerId}})),true));}else{packets++;socket.send(response(turns.slice(0,Math.min(3,packets)).map(t=>({text:t.text,...(t.startMs ? {start_time:t.startMs} : {}),end_time:t.endMs,definite:true,additions:{speaker_id:t.speakerId}}))));}});});
 const config={DOUBAO_API_KEY:'fixture',DOUBAO_ASR_URL:`ws://127.0.0.1:${server.address().port}`,DOUBAO_ASR_RESOURCE_ID:'fixture'};
 try{
  const {r,s}=fixture();delete s.asr;for(const c of r.chunks)Object.assign(c,await repo.putAudio(r.id,Buffer.alloc(6400)));await repo.insert(r);
  const tick=async()=>{await processSpeakerSources(repo,await repo.get(r.id),config,(lang,c)=>createDoubaoSpeakerStream(lang,c,{interval:1}));await wait();};
  for(let i=0;i<5;i++)await tick();let saved=await repo.get(r.id);assert.deepEqual(saved.segments.map(s=>s.speaker),['说话人 1','说话人 2','说话人 1']);assert.equal(saved.capture,'recording');assert.ok(saved.chunks.every(c=>c.state==='streaming'));
  await repo.change(r.id,r=>seal(r,[{sourceId:s.id,epoch:s.epoch,lastSequence:2}]));for(let i=0;i<4;i++)await tick();saved=await repo.get(r.id);assert.equal(saved.capture,'completed');assert.equal(connections,1);assert.equal(packets,3);assert.equal(tails,1);assert.equal(saved.segments.length,3);
 }finally{closeSpeakerStreams(repo);for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));await repo.close();await rm(root,{recursive:true,force:true});}
});
test('lost connection is fenced, replay swaps IDs safely and stale worker cannot overwrite committed turns',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-speaker-replay-')),repo=await createRepository({root});let opens=0;const clients=[];
 const factory=()=>{opens++;const state={latest:null,error:null,complete:false},client={state,ready:Promise.resolve(),writes:0,closed:false,async write(){this.writes++;state.latest=[{...turns[this.writes-1],speakerId:opens===1 ? turns[this.writes-1].speakerId : turns[this.writes-1].speakerId==='0'?'1':'0'}];},end(){state.complete=true;},close(){this.closed=true;}};clients.push(client);return client;};
 try{
  const {r,s}=fixture();delete s.asr;for(const c of r.chunks)Object.assign(c,await repo.putAudio(r.id,Buffer.alloc(6400)));await repo.insert(r);
  await processSpeakerSources(repo,await repo.get(r.id),{},factory);const stale=(await repo.get(r.id)).sources[0].asr.fence;
  clients[0].state.error=Object.assign(new Error('offline'),{code:'offline'});await processSpeakerSources(repo,await repo.get(r.id),{},factory);assert.equal(clients[0].closed,true);
  await repo.change(r.id,r=>{r.sources[0].asr.retryAt=0;});
  for(let i=0;i<3;i++)await processSpeakerSources(repo,await repo.get(r.id),{},factory);
  let saved=await repo.get(r.id);assert.deepEqual(saved.segments.map(s=>s.speaker),['说话人 1','','说话人 1']);assert.equal(saved.speakers.length,1);assert.equal(saved.segments.length,3);
  assert.equal(commitSpeakerTurns(saved,s.id,stale,[{...turns[0],text:'旧 worker 覆盖'}],1),false);assert.equal(saved.segments[0].text,turns[0].text);
  await repo.change(r.id,r=>{r.deleted=true;r.generation++;});await processSpeakerSources(repo,await repo.get(r.id),{},factory);assert.equal(clients[1].closed,true);
 }finally{closeSpeakerStreams(repo);await repo.close();await rm(root,{recursive:true,force:true});}
});
test('audio gap does not create a vendor session, and another worker respects the source lease',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-speaker-lease-')),repo=await createRepository({root});let opened=0;
 const client={state:{latest:null,error:null,complete:false},ready:Promise.resolve(),async write(){},end(){},close(){}};
 try{const {r,s}=fixture();delete s.asr;r.chunks=r.chunks.slice(1);s.watermark=-1;await repo.insert(r);await processSpeakerSources(repo,r,{},()=>{opened++;return client;});assert.equal(opened,0);
  await repo.change(r.id,r=>{r.sources[0].watermark=2;r.sources[0].asr={fence:'another-worker',lease:Date.now()+60000,state:'running'};});await processSpeakerSources(repo,await repo.get(r.id),{},()=>{opened++;return client;});assert.equal(opened,0);
 }finally{closeSpeakerStreams(repo);await repo.close();await rm(root,{recursive:true,force:true});}
});

test('public record hides connection fences and provider identity mappings',()=>{const {r,s}=fixture();s.asr.lease=123;s.asr.speakerMap={'0':'identity'};const data=publicRecord(r);assert.equal(data.sources[0].asr.fence,undefined);assert.equal(data.sources[0].asr.speakerMap,undefined);assert.equal(data.sources[0].asr.lease,undefined);});
test('exhausted earlier chunk blocks source replay until explicit retry, even when later chunks have zero attempts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-speaker-exhausted-')),repo=await createRepository({root});let opened=0;
 try{const {r,s}=fixture();delete s.asr;r.chunks[0].attempts=5;await repo.insert(r);await processSpeakerSources(repo,r,{},()=>{opened++;throw new Error('must not connect');});assert.equal(opened,0);}finally{closeSpeakerStreams(repo);await repo.close();await rm(root,{recursive:true,force:true});}
});
test('two sources feed concurrently and worker stream capacity remains bounded',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-speaker-capacity-')),repo=await createRepository({root});const before=process.env.RECORD_ASR_MAX_STREAMS;let opened=0,inFlight=0,peak=0;
 const factory=()=>{opened++;return {state:{latest:null,error:null,complete:false},ready:Promise.resolve(),async write(){inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,15));inFlight--;},end(){},close(){}};};
 try{const {r,s}=fixture();delete s.asr;const second=addSource(r,{kind:'display'});const chunk={sessionId:second.sessionId,sourceId:second.id,epoch:second.epoch,sequence:0,sampleOffset:0,sampleCount:3200,sampleRate:16000,...await repo.putAudio(r.id,Buffer.alloc(6400))};acknowledge(r,chunk);for(const c of r.chunks)Object.assign(c,await repo.putAudio(r.id,Buffer.alloc(6400)));await repo.insert(r);
  process.env.RECORD_ASR_MAX_STREAMS='2';await processSpeakerSources(repo,r,{},factory);assert.equal(opened,2);assert.equal(peak,2);closeSpeakerStreams(repo);
  await repo.change(r.id,r=>{for(const source of r.sources)delete source.asr;});opened=0;process.env.RECORD_ASR_MAX_STREAMS='1';await processSpeakerSources(repo,await repo.get(r.id),{},factory);assert.equal(opened,1);
 }finally{if(before===undefined)delete process.env.RECORD_ASR_MAX_STREAMS;else process.env.RECORD_ASR_MAX_STREAMS=before;closeSpeakerStreams(repo);await repo.close();await rm(root,{recursive:true,force:true});}
});

test('meeting-scoped SHA-256 identities survive persistence and reconnect ID reassignment',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meeting-speaker-hash-'));let repo=await createRepository({root});
 try{const {r,s}=fixture();commitSpeakerTurns(r,s.id,'one',turns,1);const hashes=r.segments.map(s=>s.speakerHash);assert.ok(hashes.every(h=>/^[a-f0-9]{64}$/.test(h)));assert.equal(hashes[0],hashes[2]);assert.notEqual(hashes[0],hashes[1]);assert.notEqual(speakerHash('other-meeting',r.speakers[0].id),hashes[0]);await repo.insert(r);await repo.close();repo=await createRepository({root});await repo.change(r.id,r=>{r.sources[0].asr={fence:'reconnected',speakerMap:{},mayAllocate:false};commitSpeakerTurns(r,s.id,'reconnected',turns.map(t=>({...t,speakerId:t.speakerId==='0'?'1':'0'})),1);});assert.deepEqual((await repo.get(r.id)).segments.map(s=>s.speakerHash),hashes);
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}
});
test('first-pass preview is fenced and does not enter confirmed transcript or minutes revision',()=>{const {r,s}=fixture();s.asr.state='running';const revision=r.transcriptRevision;assert.equal(updateTranscriptPreview(r,s.id,'stale',{text:'wrong'},{},1),false);updateTranscriptPreview(r,s.id,'one',{text:'实时草稿',startMs:0},{firstTextMs:180},1);assert.equal(r.sources[0].asr.preview.text,'实时草稿');assert.equal(r.transcriptRevision,revision);assert.equal(r.segments.length,0);updateTranscriptPreview(r,s.id,'one',null,{firstTextMs:180,firstConfirmedMs:920},1);assert.equal(r.sources[0].asr.preview,null);assert.equal(r.sources[0].asr.runtime.firstTextMs,180);});

test('manual attribution updates its hash while acoustic replay anchors remain stable',()=>{
  const {r,s}=fixture();commitSpeakerTurns(r,s.id,'one',turns,1);
  const first=r.speakers[0],second=r.speakers[1];
  editSegment(r,r.segments[0].id,{revision:1,text:'人工确认归属',speaker:second.label});
  assert.equal(r.segments[0].speakerHash,second.hash);
  assert.equal(r.segments[0].speakerId,second.id);
  s.asr={fence:'reconnected',speakerMap:{},mayAllocate:false};
  commitSpeakerTurns(r,s.id,'reconnected',turns.map(t=>({...t,speakerId:t.speakerId==='0'?'1':'0'})),1);
  assert.deepEqual(r.segments.map(s=>s.speakerHash),[second.hash,second.hash,first.hash]);
  assert.equal(r.segments[0].text,'人工确认归属');
  editSegment(r,r.segments[0].id,{revision:r.segments[0].revision,text:'归属待确认',speaker:''});
  assert.equal(r.segments[0].speakerId,null);assert.equal(r.segments[0].speakerHash,null);
  commitSpeakerTurns(r,s.id,'reconnected',turns,1);
  assert.equal(r.segments[0].speakerId,null);assert.equal(r.segments[0].speakerHash,null);
});

test('a transient speaker connection recovers after five failures without another capture or manual retry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'meeting-speaker-recover-')),repo=await createRepository({root});let opens=0;
  const factory=()=>{
    opens++;const state={latest:null,error:opens<=5?Object.assign(new Error('network'),{code:'doubao_connection_failed'}):null,complete:false};
    return {state,ready:Promise.resolve(),async write(){state.latest=[turns[0]];},end(){state.complete=true;},close(){}};
  };
  try{
    const {r,s}=fixture();delete s.asr;for(const c of r.chunks)Object.assign(c,await repo.putAudio(r.id,Buffer.alloc(6400)));await repo.insert(r);
    for(let i=0;i<5;i++){
      await processSpeakerSources(repo,await repo.get(r.id),{},factory);
      await repo.change(r.id,r=>{r.sources[0].asr.retryAt=0;});
    }
    assert.equal(opens,5);
    await processSpeakerSources(repo,await repo.get(r.id),{},factory);
    assert.equal(opens,6,'a recovered network must not leave a saved source permanently locked');
    const saved=await repo.get(r.id);assert.equal(saved.segments.length,1);assert.equal(saved.capture,'recording');
  }finally{closeSpeakerStreams(repo);await repo.close();await rm(root,{recursive:true,force:true});}
});

test('new durable audio cannot hide an existing failed speech connection as merely queued',()=>{
  const {r,s}=fixture();s.asr={state:'failed',error:'doubao_connection_failed',attempts:5,retryAt:Date.now()+60000};r.transcription='failed';
  acknowledge(r,{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence:3,sampleOffset:9600,sampleCount:3200,sampleRate:16000,digest:'next',object:'next'});
  assert.notEqual(r.transcription,'queued');assert.equal(publicRecord(r).sources[0].asr.error,'doubao_connection_failed');
});

test('cooling down speech connections do not repeatedly persist unchanged long records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'meeting-speaker-cooldown-')),repo=await createRepository({root});
  try{
    const {r,s}=fixture();s.asr={state:'failed',attempts:1,error:'doubao_connection_failed',retryAt:Date.now()+60000};await repo.insert(r);
    const change=repo.change.bind(repo);let writes=0;repo.change=(...args)=>{writes++;return change(...args);};
    for(let i=0;i<20;i++)await processSpeakerSources(repo,r,{},()=>{throw Error('must not connect during backoff');});
    assert.equal(writes,0,'backoff must not recompress and rewrite the entire meeting each tick');
  }finally{closeSpeakerStreams(repo);await repo.close();await rm(root,{recursive:true,force:true});}
});

test('saved audio recovery leaves two stream slots for an ongoing meeting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-live-priority-')), repo = await createRepository({ root });
  const before = process.env.RECORD_ASR_MAX_STREAMS; let opened = 0;
  const factory = () => { opened++; return { state: { latest: null, error: null, complete: false }, ready: Promise.resolve(), async write() {}, end() {}, close() {} }; };
  try {
    process.env.RECORD_ASR_MAX_STREAMS = '8';
    for (let i = 0; i < 8; i++) {
      const { r, s } = fixture(); delete s.asr; r.capture = 'sealed'; s.stopped = true;
      for (const chunk of r.chunks) Object.assign(chunk, await repo.putAudio(r.id, Buffer.alloc(6400)));
      await repo.insert(r); await processSpeakerSources(repo, r, {}, factory);
    }
    assert.equal(opened, 6);
    for (let i = 0; i < 2; i++) {
      const { r, s } = fixture(); delete s.asr; r.capture = 'recording';
      for (const chunk of r.chunks) Object.assign(chunk, await repo.putAudio(r.id, Buffer.alloc(6400)));
      await repo.insert(r); await processSpeakerSources(repo, r, {}, factory);
    }
    assert.equal(opened, 8);
  } finally {
    if (before === undefined) delete process.env.RECORD_ASR_MAX_STREAMS; else process.env.RECORD_ASR_MAX_STREAMS = before;
    closeSpeakerStreams(repo); await repo.close(); await rm(root, { recursive: true, force: true });
  }
});

test('public record exposes masked historical recognition failures without mutating saved state', () => {
  const { r, s } = fixture(); r.transcription = 'queued'; s.asr = { state: 'failed', error: 'doubao_http_401', retryable: false, transportCode: 'ECONNREFUSED', fence: 'private' };
  const view = publicRecord(r);
  assert.equal(view.transcription, 'blocked'); assert.equal(r.transcription, 'queued');
  assert.equal(view.sources[0].asr.retryable, false);
  assert.equal(view.sources[0].asr.transportCode, 'ECONNREFUSED');
  assert.equal(view.sources[0].asr.fence, undefined);
});

test('speech connection preserves HTTP and transport errors when the socket later closes', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => { response.writeHead(401); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { DOUBAO_API_KEY: 'fixture', DOUBAO_ASR_URL: `ws://127.0.0.1:${server.address().port}`, DOUBAO_ASR_RESOURCE_ID: 'fixture' };
  let stream = createDoubaoSpeakerStream('zh', config);
  try {
    await assert.rejects(stream.ready, error => error.code === 'doubao_http_401');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stream.state.error.code, 'doubao_http_401');
  } finally { stream.close(); await new Promise(resolve => server.close(resolve)); }
  stream = createDoubaoSpeakerStream('zh', config);
  try {
    await assert.rejects(stream.ready, error => error.code === 'doubao_connection_failed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stream.state.error.transportCode, 'ECONNREFUSED');
    assert.equal(stream.state.error.code, 'doubao_connection_failed');
  } finally { stream.close(); }
});

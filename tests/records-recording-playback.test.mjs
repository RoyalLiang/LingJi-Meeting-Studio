import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRecordServer } from '../services/records/src/server.mjs';
import { transform } from 'esbuild';
import { createRecord, addSource, acknowledge, publicRecord, pause } from '../packages/records/src/record.mjs';
import { digest } from '../packages/records/src/record.mjs';
import { runCycle } from '../services/records/src/worker.mjs';

const code = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/recording-playback.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
const sandbox = { exports: {}, encodeURIComponent };
vm.runInNewContext(code + '\nObject.assign(exports,{recordingPlaybackState,recordingAudioUrl});', sandbox);
const { recordingPlaybackState, recordingAudioUrl } = sandbox.exports;
const record = { retainAudio: true, audioPurged: false, capture: 'completed', sources: [{ id: 'received', watermark: 0, lastSequence: 0, stopped: true }, { id: 'empty', watermark: -1, lastSequence: -1, stopped: true }] };

test('original playback requires retained, unpurged and completed audio', () => {
  for (const fields of [{ retainAudio: false }, { audioPurged: true }, { capture: 'recording' }, { capture: 'paused' }]) {
    const state = recordingPlaybackState({ ...record, ...fields });
    assert.equal(state.available, false);
    assert.ok(state.message);
    assert.equal('sources' in state, false);
  }
});

test('sealed audio is playable before transcription completes only when source receipts are complete', () => {
  assert.equal(recordingPlaybackState({...record,capture:'sealed'}).available,true);
  for (const source of [{...record.sources[0],watermark:-1},{...record.sources[0],lastSequence:1},{...record.sources[0],stopped:false}]) {
    assert.equal(recordingPlaybackState({...record,capture:'sealed',sources:[source]}).available,false);
  }
  const mixed=recordingPlaybackState({...record,capture:'sealed',sources:[record.sources[0],{...record.sources[0],id:'missing',lastSequence:2}]});
  assert.deepEqual(Array.from(mixed.sources,s=>s.id),['received']);
});

test('playback exposes only sources with durable audio receipts and preserves the record', () => {
  const before = JSON.stringify(record);
  const state = recordingPlaybackState(record);
  assert.equal(state.available, true);
  assert.deepEqual(Array.from(state.sources, source => source.id), ['received']);
  assert.equal(recordingPlaybackState({ ...record, sources: [record.sources[1]] }).available, false);
  assert.equal(JSON.stringify(record), before);
});

test('audio playback stays on the authenticated same-origin route', () => {
  assert.equal(recordingAudioUrl('record/id', 'source?token=secret'), '/api/records/record%2Fid/audio/source%3Ftoken%3Dsecret');
});

test('unavailable playback explains cleanup and how to retain the next recording', () => {
  const purged = recordingPlaybackState({ ...record, retainAudio: false, audioPurged: true });
  assert.match(purged.message, /已清理.*无法恢复/);
  assert.match(purged.message, /保留原音/);
  const temporary = recordingPlaybackState({ ...record, retainAudio: false });
  assert.match(temporary.message, /未开启.*保留原音/);
  assert.match(temporary.message, /转录后清理/);
});

test('retained recordings serve complete WAV and byte ranges while temporary or purged audio stays private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tts-playback-'));
  const app = await createRecordServer({ root, databaseUrl: '', port: 0 });
  const address = await app.start(), base = `http://127.0.0.1:${address.port}/api`;
  const pcm = [Buffer.alloc(3200, 5), Buffer.alloc(1600, 9)], audioBytes = Buffer.concat(pcm);
  try {
    const registration = await fetch(base + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'playback@example.test', password: 'playback-test-password' }) });
    const user = await registration.json(), headers = { Cookie: registration.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': user.csrf, 'Content-Type': 'application/json' };
    async function post(path, body) {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response.json();
    }
    async function recording(retainAudio) {
      const saved = await post('/records', { retainAudio }), source = await post(`/records/${saved.id}/sources`, { kind: 'microphone' });
      let sampleOffset = 0;
      for (const [sequence, bytes] of pcm.entries()) {
        await post(`/records/${saved.id}/audio`, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence, sampleOffset,
          sampleCount: bytes.length / 2, sampleRate: 16000, digest: digest(bytes), pcm: bytes.toString('base64') });
        sampleOffset += bytes.length / 2;
      }
      await post(`/records/${saved.id}/seal`, { sources: [{ sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, lastSequence: 1 }] });
      return { id: saved.id, sourceId: source.id };
    }
    const retained = await recording(true), url = base + recordingAudioUrl(retained.id, retained.sourceId).slice(4);
    const early=await fetch(url,{headers}),earlyWav=Buffer.from(await early.arrayBuffer());
    assert.equal(early.status,200,'complete retained audio is playable while ASR is pending');
    const waveform=await fetch(url+'?waveform=1',{headers});
    assert.equal(waveform.status,200);assert.equal(waveform.headers.get('cache-control'),'no-store');
    const peaks=await waveform.json();assert.equal(peaks.samples,2400);assert.equal(peaks.peaks.length,192);
    assert.ok(peaks.peaks.slice(0,128).every(value=>value===1285/32768));assert.ok(peaks.peaks.slice(128).every(value=>value===2313/32768));
    assert.equal((await fetch(url+'?waveform=1')).status,401);
    assert.deepEqual(earlyWav.subarray(44),audioBytes);
    const download=await fetch(url+'?download=1',{headers});
    assert.equal(download.status,200);
    assert.match(download.headers.get('content-disposition'),/^attachment;.*filename\*=UTF-8''.*\.wav$/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),earlyWav,'export preserves every retained PCM sample while ASR is pending');
    assert.equal((await app.repo.get(retained.id)).capture,'sealed');
    assert.ok((await app.repo.get(retained.id)).chunks.every(chunk=>chunk.state!=='done'));
    await app.repo.change(retained.id,value=>{value.sources[0].watermark=0;});
    assert.equal((await fetch(url,{headers})).status,404,'a missing durable receipt blocks playback');
    assert.equal((await fetch(url+'?waveform=1',{headers})).status,404);
    await app.repo.change(retained.id,value=>{value.sources[0].watermark=1;});
    const earlyPart=await fetch(url,{headers:{...headers,Range:'bytes=0-43'}});
    assert.equal(earlyPart.status,206);assert.deepEqual(Buffer.from(await earlyPart.arrayBuffer()),earlyWav.subarray(0,44));
    let release,entered,closed,returned;
    const gate=new Promise(resolve=>{release=resolve;}),reading=new Promise(resolve=>{entered=resolve;}),disconnected=new Promise(resolve=>{closed=resolve;}),readDone=new Promise(resolve=>{returned=resolve;});
    const readAudio=app.repo.readAudio.bind(app.repo);let writesAfterClose=0;
    const monitor=(req,res)=>{
      if(!req.url.includes('/audio/'))return;
      res.once('close',closed);const write=res.write.bind(res);
      res.write=(...args)=>{if(res.destroyed||res.writableEnded)writesAfterClose++;return write(...args);};
    };
    app.repo.readAudio=async object=>{entered();await gate;const bytes=await readAudio(object);returned();return bytes;};
    app.server.on('request',monitor);
    try {
      const abort=new AbortController();const active=await fetch(url,{headers,signal:abort.signal});
      await active.body.getReader().read();await reading;abort.abort();await disconnected;release();await readDone;
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(writesAfterClose,0,'seeking/cancelling must not write audio after the response closes');
      assert.equal((await fetch(base+'/health')).status,200);
    } finally {release();app.repo.readAudio=readAudio;app.server.off('request',monitor);}
    for (let i = 0; i < pcm.length; i++) await runCycle(app.repo, { transcribe: async () => '' }, { lane: 'audio' });
    const completed = await app.repo.get(retained.id);
    assert.equal(completed.capture, 'completed');
    assert.equal(completed.sources[0].watermark, completed.sources[0].lastSequence);
    const full = await fetch(url, { headers }), wav = Buffer.from(await full.arrayBuffer());
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/wav');
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('content-length'), String(audioBytes.length + 44));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), audioBytes.length);
    assert.deepEqual(wav.subarray(44), audioBytes);
    for (const [start, end] of [[0, 43], [3238, 3250], [3244, wav.length - 1]]) {
      const part = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${wav.length}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), wav.subarray(start, end + 1));
    }
    assert.equal((await fetch(url, { headers: { ...headers, Range: `bytes=${wav.length}-` } })).status, 416);
    assert.equal((await fetch(url)).status, 401);
    await app.repo.change(retained.id, value => { value.audioPurged = true; });
    assert.equal((await fetch(url, { headers })).status, 404, 'purged flag denies even an object still on disk');
    const temporary = await recording(false), temporaryUrl = base + recordingAudioUrl(temporary.id, temporary.sourceId).slice(4);
    await app.repo.change(temporary.id, value => { value.capture = 'completed'; });
    assert.equal((await fetch(temporaryUrl, { headers })).status, 404, 'temporary objects do not override retention consent');
    await app.repo.change(temporary.id, value => { value.capture = 'sealed'; });
    for (let i = 0; i < pcm.length; i++) await runCycle(app.repo, { transcribe: async () => '' }, { lane: 'audio' });
    const cleaned = await app.repo.get(temporary.id);
    assert.equal(cleaned.audioPurged, true);
    assert.equal(cleaned.retainAudio, false);
    await assert.rejects(app.repo.readAudio(cleaned.chunks[0].object), /ENOENT/);
    assert.equal((await fetch(temporaryUrl, { headers })).status, 404);
  } finally {
    await app.stop();
    await rm(root, { recursive: true });
  }
});

async function renderAudioDuration(record) {
  const source = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const span = source.match(/<time className="record-duration"[^>]*>\{timecode\(displayDurationMs\)\}<\/time>/)?.[0];
  assert.ok(span, 'use the actual meeting header');
  const code = (await transform(`exports.render = () => (${span});`, { loader: 'tsx' })).code;
  const sandbox = { exports: {}, record, displayDurationMs: record.durationMs, React: { createElement: (_tag, _props, ...children) => children.join('') }, timecode: ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000 % 60)).padStart(2, '0')}` };
  vm.runInNewContext(code, sandbox);
  return sandbox.exports.render();
}
function timedRecording() {
  const record = createRecord('duration-fixture'), mic = addSource(record, { kind: 'microphone' }), display = addSource(record, { kind: 'display' });
  for (const [source, count] of [[mic, 88], [display, 72]]) for (let sequence = 0; sequence < count; sequence++) acknowledge(record, { sessionId: source.sessionId, sourceId: source.id, epoch: source.epoch, sequence, sampleOffset: sequence * 240000, sampleCount: 240000, sampleRate: 16000, digest: `fixture-${source.id}-${sequence}`, object: 'fixture' });
  return record;
}
test('meeting header shows a 22-minute dual-source timeline instead of 40 track-minutes', async () => {
  const record = timedRecording(), detail = publicRecord(record);
  assert.equal(record.usage.samples / 16000, 40 * 60, 'aggregate usage still counts both tracks');
  assert.match(await renderAudioDuration(detail), /^22:00$/);
});
test('meeting duration includes resumed audio once while parallel and empty sources do not inflate it', async () => {
  const record = timedRecording();
  pause(record, record.sources.map(s => ({ sourceId: s.id, epoch: s.epoch, lastSequence: s.watermark })));
  const resumed = addSource(record, { kind: 'microphone' }); addSource(record, { kind: 'display' });
  for (let sequence = 0; sequence < 4; sequence++) acknowledge(record, { sessionId: resumed.sessionId, sourceId: resumed.id, epoch: resumed.epoch, sequence, sampleOffset: sequence * 240000, sampleCount: 240000, sampleRate: 16000, digest: `resumed-${sequence}`, object: 'fixture' });
  assert.match(await renderAudioDuration(publicRecord(record)), /^23:00$/);
});

test('ending a meeting exposes playback immediately without preloading original audio',async()=>{
 const {build}=await import('esbuild'),{createRequire}=await import('node:module'),React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const compiled=await build({entryPoints:['apps/web/src/components/RecordingPlayback.tsx'],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom']});
 const module={exports:{}};vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:name=>name==='react-dom'?{createPortal:children=>children}:createRequire(import.meta.url)(name),console,document:{body:{},documentElement:{lang:'zh-CN'}}});
 const html=renderToStaticMarkup(React.createElement(module.exports.RecordingPlayback,{record:{...record,id:'fixture'}}));
 assert.match(html,/aria-label="播放原音"/);assert.match(html,/<audio[^>]*preload="none"/);assert.doesNotMatch(html,/打开原音回放|点击加载回放|会议录音<|双音轨同步/);
});


test('tail byte ranges read only intersecting original audio chunks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-range-tail-')),app=await createRecordServer({root,databaseUrl:'',port:0});
 try{
 const addr=await app.start(),base=`http://127.0.0.1:${addr.port}/api`;
 const registration=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'synthetic-audio@example.test',password:'synthetic-test-password'})});
 const user=await registration.json(),headers={Cookie:registration.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
 const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(res.ok,`${path}:${res.status}`);return res.json();};
 const r=await post('/records',{retainAudio:true}),s=await post(`/records/${r.id}/sources`,{kind:'microphone'}),pcm=Buffer.alloc(3200,5),count=20;
 for(let sequence=0;sequence<count;sequence++)await post(`/records/${r.id}/audio`,{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence,sampleOffset:sequence*1600,sampleCount:1600,sampleRate:16000,digest:digest(pcm),pcm:pcm.toString('base64')});
 await post(`/records/${r.id}/seal`,{sources:[{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,lastSequence:count-1}]});
 const read=app.repo.readAudio.bind(app.repo);let calls=0;app.repo.readAudio=async object=>{calls++;return read(object);};
 const url=base+`/records/${r.id}/audio/${s.id}`,last=44+count*pcm.length-1;
 const range=await fetch(url,{headers:{...headers,Range:`bytes=${last-1}-${last}`}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,2);const rangeReads=calls;
 calls=0;const wave=await fetch(url+'?waveform=1',{headers});assert.equal(wave.status,200);await wave.json();

 assert.equal(rangeReads,1,'tail seeking must not read preceding PCM chunks');
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});


test('active recording time ignores batched audio receipts, freezes on pause and resets by record',async()=>{
 const source=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/signal.ts',import.meta.url),'utf8'));
 const {RecordingClock}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const clock=new RecordingClock();
 assert.equal(clock.read('first',120000,true,100),120000);
 for(const [now,receipt] of [[600,120000],[1100,121900],[1600,120800],[2100,124500],[4100,122000]])assert.equal(clock.read('first',receipt,true,now),120000+now-100);
 assert.equal(clock.read('first',124000,false,4200),124000);assert.equal(clock.read('first',124000,false,14200),124000);
 assert.equal(clock.read('first',124000,true,15000),124000);assert.equal(clock.read('first',124000,true,16000),125000);
 assert.equal(clock.read('second',0,true,17000),0);assert.equal(clock.read('second',0,true,18000),1000);
 assert.equal(clock.read('second',1200,false,19000),1200,'completed time follows real saved PCM');
});

test('late microphone starts at the received meeting timeline without changing stream identities',()=>{
 const r=createRecord('late-source'),display=addSource(r,{kind:'display'});
 acknowledge(r,{sessionId:display.sessionId,sourceId:display.id,epoch:display.epoch,sequence:0,sampleOffset:0,sampleCount:16000,sampleRate:16000,digest:'first',object:'first'});
 const mic=addSource(r,{kind:'microphone'});assert.equal(mic.sessionId,display.sessionId);assert.equal(mic.timelineOffsetMs,1000);
 const chunk={sessionId:mic.sessionId,sourceId:mic.id,epoch:mic.epoch,sequence:0,sampleOffset:0,sampleCount:8000,sampleRate:16000,digest:'second',object:'second'};
 acknowledge(r,chunk);acknowledge(r,chunk);assert.equal(publicRecord(r).durationMs,1500);assert.equal(r.usage.samples,24000);
});

test('resumed and late sources expose global WAV and waveform positions with bounded Range reads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tts-global-playback-')),app=await createRecordServer({root,databaseUrl:'',port:0});
 try{
 const addr=await app.start(),base=`http://127.0.0.1:${addr.port}/api`;
 const registration=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'global-audio@example.test',password:'synthetic-test-password'})});
 const user=await registration.json(),headers={Cookie:registration.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':user.csrf,'Content-Type':'application/json'};
 const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(res.ok,`${path}:${res.status}`);return res.json();};
 const originalRead=app.repo.readAudio.bind(app.repo);let reads=0;app.repo.readAudio=async object=>{reads++;return originalRead(object);};
 for(const resume of [false,true]){
  const r=await post('/records',{retainAudio:true});
  const add=async(kind,count,value)=>{const s=await post(`/records/${r.id}/sources`,{kind}),pcm=Buffer.alloc(count*2,value);await post(`/records/${r.id}/audio`,{sessionId:s.sessionId,sourceId:s.id,epoch:s.epoch,sequence:0,sampleOffset:0,sampleCount:count,sampleRate:16000,digest:digest(pcm),pcm:pcm.toString('base64')});return s;};
  const first=await add('display',16000,5);
  if(resume)await post(`/records/${r.id}/pause`,{sources:[{sourceId:first.id,epoch:first.epoch,lastSequence:0}]});
  const second=await add('microphone',8000,9);assert.equal(second.timelineOffsetMs,1000);
  await post(`/records/${r.id}/seal`,{sources:[first,second].map(s=>({sourceId:s.id,epoch:s.epoch,lastSequence:0}))});
  const url=base+`/records/${r.id}/audio/${second.id}`,wav=Buffer.from(await(await fetch(url,{headers})).arrayBuffer());
  assert.equal(wav.readUInt32LE(40),48000);assert.ok(wav.subarray(44,32044).every(v=>v===0));assert.deepEqual(wav.subarray(32044),Buffer.alloc(16000,9));
  const wave=await(await fetch(url+'?waveform=1',{headers})).json();assert.equal(wave.samples,24000);assert.ok(wave.peaks.slice(0,128).every(v=>v===0));assert.ok(wave.peaks.slice(128).every(v=>v>0));
  for(const [range,expected,count] of [['bytes=0-43',wav.subarray(0,44),0],['bytes=44-53',Buffer.alloc(10),0],['bytes=32042-32045',Buffer.from([0,0,9,9]),1],['bytes=48042-48043',Buffer.from([9,9]),1]]){
   reads=0;const res=await fetch(url,{headers:{...headers,Range:range}});assert.equal(res.status,206);assert.deepEqual(Buffer.from(await res.arrayBuffer()),expected);assert.equal(reads,count,range);
  }
  const detail=await(await fetch(base+`/records/${r.id}`,{headers})).json();assert.equal(detail.durationMs,1500);assert.equal(detail.usage.samples,24000);
 }
 }finally{await app.stop();await rm(root,{recursive:true,force:true});}
});

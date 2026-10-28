import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { transform } from 'esbuild';

async function quickRecordHarness({ active, issues, minutesMode = 'asr-llm' }) {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  async function quickRecord()');
  const end = app.indexOf('  async function startCapture(', start);
  assert.ok(start >= 0 && end > start);
  const compiled = (await transform(app.slice(start, end) + '\nexports.quickRecord = quickRecord;', { loader: 'ts' })).code;
  const state = { modal: undefined, error: '', recording: false, issues: [], created: null, starts: 0 };
  const controller = { active, startMeeting: async () => { state.starts++; return issues; }, stop: async () => { controller.active = false; } };
  const sandbox = { exports: {}, recording: false, busy: false, scope: 'all', boot: { providers: { minutes: true, minutesMode } }, captureAllowed: () => true,
    capture: { current: null }, activeId: { current: '' }, controllerFor: () => controller,
    api: async (_path, method, body) => method === 'POST' ? (state.created = body, { id: 'quick-fixture' }) : { records: [{ id: 'quick-fixture' }] },
    setError: value => { state.error = value; }, setCaptureIssues: value => { state.issues = value; }, setBusy() {}, setCapturePhase() {},
    selectRecord() {}, setRecord() {}, setQueueRecords() {}, loadList: async () => {}, refresh: async () => {},
    setModal: value => { state.modal = value; }, setRecording: value => { state.recording = value; }, messageOf: error => error.message,
  };
  vm.runInNewContext(compiled, sandbox);
  await sandbox.exports.quickRecord();
  return { state, capture: sandbox.capture };
}

test('quick recording keeps a working microphone active without opening source selection after another lane fails', async () => {
  const h = await quickRecordHarness({ active: true, issues: [{ kind: 'display', message: '系统音频权限被拒绝' }] });
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.recording, true);
  assert.equal(h.state.modal, null);
  assert.equal(h.state.error, '系统音频权限被拒绝', 'partial failure must remain visible without interrupting working capture');
  assert.equal(h.state.issues.length, 1);
  assert.equal(h.state.created.retainAudio, true);
  assert.equal(h.state.created.autoMinutes, true, 'legacy text mode keeps automatic minutes');
});

test('quick recording opens explicit recovery only when no requested audio source could start', async () => {
  const h = await quickRecordHarness({ active: false, issues: [{ kind: 'microphone', message: '麦克风权限被拒绝' }, { kind: 'display', message: '系统音频权限被拒绝' }] });
  assert.equal(h.state.recording, false);
  assert.equal(h.state.modal, 'capture');
  assert.equal(h.state.issues.length, 2);
  assert.equal(h.capture.current, null);
});

test('quick recording with both sources available starts immediately without a selection prompt', async () => {
  const h = await quickRecordHarness({ active: true, issues: [] });
  assert.equal(h.state.recording, true);
  assert.equal(h.state.modal, null);
  assert.equal(h.state.error, '');
});

async function microphoneActionHarness({ failure = null, meetingIssues = [], initialModal = null, existingMicrophone = false } = {}) {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  async function startCapture('), end = app.indexOf('  async function onImport(', start);
  assert.ok(start >= 0 && end > start);
  const compiled = (await transform(app.slice(start, end) + '\nexports.actions = {startCapture,toggleMicrophone};', { loader: 'ts' })).code;
  const state = { modal: initialModal, recording: true, issues: [], error: '', starts: [], meetingStarts: 0, disconnects: [], refreshes: 0 };
  const controller = { active: true, sources: [{ kind: 'display' }, ...(existingMicrophone ? [{kind:'microphone'}] : [])],
    async start(kind) { state.starts.push(kind); if (failure) throw failure; const source={kind}; this.sources.push(source); return source; },
    async startMeeting() { state.meetingStarts++; return meetingIssues; },
    async disconnect(kind) { state.disconnects.push(kind); this.sources=this.sources.filter(source=>source.kind!==kind); },
  };
  const sandbox = { exports: {}, setCapturePhase() {}, record: {id:'fixture',capture:'recording'}, busy: false, modal: initialModal,
    captureAllowed:()=>true, capture:{current:controller}, controllerFor:()=>controller,
    setError:value=>{state.error=value;}, dismissToast(){}, setBusy(){},
    setCaptureIssues:value=>{state.issues=value;}, setRecording:value=>{state.recording=value;},
    setModal:value=>{state.modal=value;}, refresh:async()=>{state.refreshes++;}, messageOf:error=>error.message,
    quickRecord:assert.fail, stopCapture:assert.fail, showToast(){},
  };
  vm.runInNewContext(compiled,sandbox);
  return {state,controller,...sandbox.exports.actions};
}

test('enable microphone failure stays inline and never opens the audio-source chooser', async () => {
  const h=await microphoneActionHarness({failure:new Error('麦克风权限被拒绝')});
  await h.toggleMicrophone();
  assert.equal(h.state.modal,null);
  assert.equal(h.state.error,'麦克风权限被拒绝');
  assert.equal(h.state.recording,true,'existing system audio must continue');
  assert.deepEqual(h.state.starts,['microphone']);
  assert.equal(h.state.issues[0].kind,'microphone');
});

test('starting an existing meeting keeps partial failures inline without forcing source selection', async () => {
  const h=await microphoneActionHarness({meetingIssues:[{kind:'microphone',message:'麦克风暂时无法使用'}]});
  await h.startCapture('meeting');
  assert.equal(h.state.modal,null);
  assert.equal(h.state.error,'麦克风暂时无法使用');
  assert.equal(h.state.meetingStarts,1);
  assert.equal(h.state.recording,true);
});

test('enable microphone starts directly and a successful explicit recovery closes its source chooser', async () => {
  const h=await microphoneActionHarness(); await h.toggleMicrophone();
  assert.deepEqual(h.state.starts,['microphone']);assert.equal(h.state.modal,null);
  const recovery=await microphoneActionHarness({initialModal:'capture'});await recovery.startCapture('microphone');
  assert.equal(recovery.state.modal,null);assert.equal(recovery.state.error,'');
  const off=await microphoneActionHarness({existingMicrophone:true});await off.toggleMicrophone();
  assert.deepEqual(off.state.disconnects,['microphone']);assert.equal(off.state.modal,null);
});

async function captureHarness({ noDisplayAudio = false, micFailure = false, displayDenied = false, displayUnsupported = false, recordId = 'record', chunkWait, displayVideo = false, enqueueFailure = false, capacityFailure = false } = {}) {
  let source = await readFile(new URL('../apps/web/src/audio/capture.ts', import.meta.url), 'utf8');
  source = stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^import .*$/gm, '').replace(/export /g, '');
  const signalSource = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/signal.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
  const health = [], nodes = [], calls = [], contexts = [], uploads = [], errors = [], ended = []; let sourceNumber = 0;
  const track = label => ({ label, enabled: true, muted: false, readyState: 'live', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, stop() { this.readyState = 'ended'; } });
  const stream = (label, audio = true) => { const audioTrack = track(label), videoTrack = track(label + " video"); return { audioTrack, getAudioTracks: () => audio ? [audioTrack] : [], videoTrack, getTracks: () => displayVideo && label === '测试共享音频' ? [audioTrack, videoTrack] : [audioTrack] }; };
  const mic = stream('测试麦克风'), display = stream('测试共享音频', !noDisplayAudio);
  class AudioContext {
    constructor() { this.state = 'suspended'; this.handlers = {}; contexts.push(this); this.audioWorklet = { addModule: async () => {} }; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    createMediaStreamSource() { return { connect: () => ({ connect: () => ({ connect() {} }) }) }; }
    createGain() { return { gain: { value: 1 } }; }
  }
  class AudioWorkletNode { constructor() { this.port = { postMessage: message => { if (message.type === 'flush' || message.type === 'pause') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } })); } }; nodes.push(this); } }
  const sandbox = { exports: {}, AudioContext, AudioWorkletNode, DOMException, Error, window: { setTimeout, clearTimeout, isSecureContext: true }, setTimeout, clearTimeout,
    navigator: { mediaDevices: {
      getUserMedia: async () => { calls.push('microphone'); if (micFailure) throw new Error('麦克风权限被拒绝'); return calls.filter(call => call === 'microphone').length === 1 ? mic : stream('测试麦克风'); },
      getDisplayMedia: displayUnsupported ? undefined : async options => { calls.push({ display: options }); if (displayDenied) throw new DOMException('Permission denied', 'NotAllowedError'); return display; },
    } },
    ensureAudioCapacity: async () => { if(capacityFailure) throw new Error('本机录音缓存空间不足，尚未开始录音'); }, preferredDevice: () => 'default', inputDevices: async () => [], microphoneConstraints: () => ({}),
    api: async (_url, _method, input) => ({ id: `source-${input.kind}-${++sourceNumber}`, sessionId: 'session', epoch: 'epoch', ...input }),
    makeChunk: async (...args) => { await chunkWait; return { sourceId: args[0], sequence: args[2], sampleOffset: args[3], buffer: args[4] }; }, enqueue: async (_id, chunk) => { if(enqueueFailure) throw new Error("本机存储空间不足"); uploads.push(chunk); }, drainQueue: async () => {},
  };
  sandbox.openMicrophone = () => sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  vm.runInNewContext(signalSource + '\n' + source + '\nexports.CaptureController = CaptureController;', sandbox);
  const controller = new sandbox.exports.CaptureController(recordId, () => {}, (error, continuing) => errors.push({error, continuing}), () => {}, () => ended.push(true), sources => health.push(structuredClone(sources)));
  return { controller, nodes, health, calls, contexts, mic, display, uploads, errors, ended };
}

test('quick recording requests both permissions before record creation completes', async () => {
  let resolveRecord;
  const recordId = new Promise(resolve => { resolveRecord = resolve; });
  const h = await captureHarness({ recordId });
  const started = h.controller.startMeeting();
  assert.equal(h.calls.filter(call => call === 'microphone').length, 1);
  assert.equal(h.calls.filter(call => typeof call === 'object').length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.sources.length, 0);
  resolveRecord('quick-record');
  assert.equal((await started).length, 0);
  assert.equal(h.controller.sources.length, 2);
  await h.controller.stop();
});

test('default meeting capture includes both microphone and meeting output', async () => {
  const h = await captureHarness();
  assert.equal((await h.controller.startMeeting()).length, 0);
  assert.equal(h.calls.filter(call => call === 'microphone').length, 1);
  assert.deepEqual(Array.from(h.controller.sources, source => source.kind).sort(), ['display','microphone']);
  assert.equal(h.calls[0].display.video.displaySurface, 'monitor');
});

test('browser-muted microphone PCM is not saved as speech', async () => {
  const h = await captureHarness();
  await h.controller.start('microphone');
  h.mic.audioTrack.muted = true; h.mic.audioTrack.handlers.mute();
  h.nodes[0].port.onmessage({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(3000).buffer } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.length, 0);
});

test('failed quick record creation releases both acquired streams', async () => {
  let rejectRecord;
  const recordId = new Promise((_, reject) => { rejectRecord = reject; });
  const h = await captureHarness({ recordId });
  const started = h.controller.startMeeting();
  await new Promise(resolve => setImmediate(resolve));
  rejectRecord(new Error('record creation failed'));
  assert.equal((await started).length, 2);
  assert.equal(h.controller.active, false);
  assert.equal(h.mic.audioTrack.readyState, 'ended');
  assert.equal(h.display.audioTrack.readyState, 'ended');
});

test('actual capture path reports zero PCM as silence instead of indefinitely appearing healthy', async () => {
  const h = await captureHarness();
  await h.controller.start('microphone');
  for (let i = 0; i < 6; i++) h.nodes[0].port.onmessage({ data: { type: 'pcm', buffer: new ArrayBuffer(32000) } });
  assert.equal(h.health.at(-1)?.[0]?.status, 'silent');
  assert.equal(h.health.at(-1)[0].rms, 0);
  assert.match(h.health.at(-1)[0].message, /没有.*声音|静音/);
  const pcm = new Int16Array(16000).fill(3000);
  h.nodes[0].port.onmessage({ data: { type: 'pcm', buffer: pcm.buffer } });
  assert.equal(h.health.at(-1)[0].status, 'audible');
  h.mic.audioTrack.muted = true; h.mic.audioTrack.handlers.mute();
  assert.equal(h.health.at(-1)[0].status, 'muted');
});

test('meeting capture requests system audio in the user gesture alongside the microphone', async () => {
  const h = await captureHarness();
  const started = h.controller.startMeeting();
  assert.ok(h.calls[0]?.display, 'display permission must start before yielding the gesture');
  await started;
  assert.deepEqual(Array.from(h.controller.sources, s => s.kind).sort(), ['display','microphone']);
  assert.equal(h.calls[0].display.systemAudio, 'include');
  assert.equal(h.calls[0].display.windowAudio, 'system');
  assert.equal(h.calls[0].display.selfBrowserSurface, 'exclude');
  assert.equal(h.calls[0].display.audio.suppressLocalAudioPlayback, false);
  assert.equal(h.health.at(-1).length, 2);
});

test('missing shared audio never silently turns into successful meeting capture', async () => {
  const h = await captureHarness({ noDisplayAudio: true });
  await assert.rejects(h.controller.start('display'), /没有音轨/);
  assert.equal(h.controller.active, false);
  assert.equal(h.display.audioTrack.readyState, 'ended');
});
test('failed remote audio sharing preserves an already recording microphone', async () => {
  const h=await captureHarness({noDisplayAudio:true});
  await h.controller.start('microphone');
  await assert.rejects(h.controller.start('display'), /没有音轨/);
  assert.equal(h.controller.active,true);
  assert.deepEqual(Array.from(h.controller.sources,s=>s.kind),['microphone']);
  assert.equal(h.mic.audioTrack.readyState,'live');
});

test('explicit microphone denial preserves the working system-audio source', async () => {
  const h = await captureHarness({ micFailure: true });
  assert.deepEqual(Array.from(await h.controller.startMeeting(), issue => issue.kind), ['microphone']);
  await assert.rejects(h.controller.start('microphone'), /麦克风权限/);
  assert.equal(h.controller.active, true);
  assert.deepEqual(Array.from(h.controller.sources, source => source.kind), ['display']);
});

test('missing shared audio reports the problem while retaining the default microphone', async () => {
  const h = await captureHarness({ noDisplayAudio: true });
  const issues = await h.controller.startMeeting();
  assert.deepEqual(Array.from(issues, issue => issue.kind), ['display']);
  assert.equal(h.controller.active, true);
  assert.deepEqual(Array.from(h.controller.sources, source => source.kind), ['microphone']);
  await h.controller.startMeeting();
  assert.equal(h.calls.filter(call => call === 'microphone').length, 1);
});

test('denied or unsupported sharing reports partial capture without losing the microphone', async () => {
  for (const options of [{ displayDenied: true }, { displayUnsupported: true }]) {
    const h = await captureHarness(options);
    const issues = await h.controller.startMeeting();
    assert.deepEqual(Array.from(issues, issue => issue.kind), ['display']);
    assert.equal(h.controller.active, true);
    assert.deepEqual(Array.from(h.controller.sources, source => source.kind), ['microphone']);
    assert.equal(h.calls.filter(call => call === 'microphone').length, 1);
    assert.match(issues[0].message, /会议音频/);
    await h.controller.stop();
  }
});

test('meeting retries do not reopen an explicitly closed microphone', async () => {
  const h = await captureHarness();
  await h.controller.startMeeting();
  await h.controller.start('microphone');
  const oldNode = h.nodes[1], oldHandler = oldNode.port.onmessage;
  await h.controller.disconnect('microphone');
  assert.equal(h.mic.audioTrack.readyState, 'ended');
  assert.equal(h.contexts[1].state, 'closed');
  assert.equal(oldNode.port.onmessage, null);
  assert.equal(h.display.audioTrack.readyState, 'live');
  assert.equal(h.controller.active, true);
  await h.controller.startMeeting();
  assert.equal(h.calls.filter(call => call === 'microphone').length, 1);
  oldHandler({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(3000).buffer } });
  const displayHandler = h.nodes[0].port.onmessage;
  displayHandler({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(2000).buffer } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].sourceId, h.controller.sources[0].id);
  assert.equal(h.uploads[0].sequence, 0);
  assert.equal(h.uploads[0].sampleOffset, 0);
  await h.controller.stop();
  assert.equal(h.display.audioTrack.readyState, 'ended');
});

test('reopening the microphone uses a new source and never replays its discarded buffer', async () => {
  const h = await captureHarness();
  await h.controller.start('microphone');
  const oldSource = h.controller.sources[0], oldHandler = h.nodes[0].port.onmessage;
  // Stop before the asynchronous chunk hash/enqueue completes.
  oldHandler({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(3000).buffer } });
  await h.controller.disconnect('microphone');
  assert.equal(h.controller.active, false);
  await h.controller.start('microphone');
  const next = h.controller.sources[0];
  assert.notEqual(next.id, oldSource.id);
  h.nodes[1].port.onmessage({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(2000).buffer } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].sourceId, next.id);
  assert.equal(h.uploads[0].sequence, 0);
  assert.equal(h.uploads[0].sampleOffset, 0);
  await h.controller.stop();
});

test('disabled and muted tracks cannot enqueue PCM but unmuted input can resume', async () => {
  const h = await captureHarness();
  await h.controller.start('microphone');
  const emit = () => h.nodes[0].port.onmessage({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(3000).buffer } });
  h.mic.audioTrack.enabled = false; emit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.length, 0);
  h.mic.audioTrack.enabled = true; h.mic.audioTrack.muted = true; emit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.length, 0);
  h.mic.audioTrack.muted = false; emit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].sequence, 0);
  assert.equal(h.uploads[0].sampleOffset, 0);
});

test('ending recording drains an in-flight chunk instead of discarding it like microphone-off', async () => {
  let resolveChunk;
  const chunkWait = new Promise(resolve => { resolveChunk = resolve; });
  const h = await captureHarness({ chunkWait });
  await h.controller.startMeeting();
  h.nodes[0].port.onmessage({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(3000).buffer } });
  const stopped = h.controller.stop();
  await new Promise(resolve => setImmediate(resolve));
  resolveChunk(); await stopped;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.controller.sources.length, 0);
  assert.equal(h.display.audioTrack.readyState, 'ended');
});

test('concurrent starts share one acquisition per source', async () => {
  const h = await captureHarness();
  const first = h.controller.startMeeting(), second = h.controller.startMeeting();
  assert.equal((await first).length, 0);
  assert.equal((await second).length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.controller.sources.length, 2);
  await h.controller.startMeeting();
  assert.equal(h.calls.length, 2);
});

async function deviceHarness({ explicit = false, denied = false } = {}) {
  const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/devices.ts', import.meta.url),'utf8')).replace(/export /g,'');
  const calls=[]; let stopped=false;
  const devices=[{deviceId:'default',kind:'audioinput',groupId:'virtual',label:'Default - System Audio'},{deviceId:'loop',kind:'audioinput',groupId:'virtual',label:'System Audio'},{deviceId:'physical',kind:'audioinput',groupId:'hardware',label:'MacBook Pro Microphone'}];
  const sandbox={exports:{},DOMException,localStorage:{getItem:()=> 'default'},navigator:{mediaDevices:{
    enumerateDevices:async()=>calls.length ? devices : devices.map(d=>({...d,label:'',groupId:''})),
    getUserMedia:async options=>{calls.push(options);if(denied)throw new DOMException('Permission denied','NotAllowedError');return {getAudioTracks:()=>[{label:options.audio.deviceId?.exact==='physical'?'MacBook Pro Microphone':'System Audio'}],getTracks:()=>[{stop(){stopped=true;}}]};}
  }}};
  vm.runInNewContext(source+'\nObject.assign(exports,{openMicrophone,microphoneConstraints,inputDevices});',sandbox);
  const stream=await sandbox.exports.openMicrophone(explicit?'loop':'default');
  return {calls,stream,stopped,sandbox,devices};
}

test('automatic microphone selection avoids a virtual System Audio input once permission reveals labels',async()=>{
  const h=await deviceHarness();
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].audio.deviceId.exact,'physical');assert.equal(h.stopped,true);
  assert.equal(h.stream.getAudioTracks()[0].label,'MacBook Pro Microphone');
  const inputs=await h.sandbox.exports.inputDevices();
  assert.equal(h.sandbox.exports.microphoneConstraints('default',inputs).deviceId.exact,'physical');
});

test('explicit virtual input remains intentional and ordinary default microphones are preserved',async()=>{
  const h=await deviceHarness({explicit:true});assert.equal(h.calls.length,1);assert.equal(h.calls[0].audio.deviceId.exact,'loop');
  const options=h.sandbox.exports.microphoneConstraints('default',[{id:'physical',label:'MacBook Microphone',isDefault:true}]);
  assert.equal(options.deviceId,undefined);
});

test('microphone permission denial is surfaced without trying alternative devices',async()=>{
  await assert.rejects(deviceHarness({denied:true}),{name:'NotAllowedError'});
});


test('pause retains shared permission, drains PCM and resumes with a new source', async () => {
  const h = await captureHarness();
  await h.controller.start('display');
  const oldSource = h.controller.sources[0], oldHandler = h.nodes[0].port.onmessage;
  oldHandler({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(2000).buffer } });
  await h.controller.pause();
  assert.equal(h.display.audioTrack.readyState, 'live');
  assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.controller.active, false);
  assert.equal(h.uploads.length, 1);
  await h.controller.startMeeting();
  assert.equal(h.calls.filter(call => typeof call === 'object').length, 1);
  assert.equal(h.calls.filter(call => call === 'microphone').length, 0);
  const next = h.controller.sources[0];
  assert.notEqual(next.id, oldSource.id);
  h.nodes[1].port.onmessage({ data: { type: 'pcm', buffer: new Int16Array(1600).fill(2000).buffer } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.uploads.at(-1).sourceId, next.id);
  assert.equal(h.uploads.at(-1).sequence, 0);
  assert.equal(h.uploads.at(-1).sampleOffset, 0);
  await h.controller.pause(); await h.controller.stop();
  assert.equal(h.display.audioTrack.readyState, 'ended');
});

test('meeting starts the microphone and shared audio by default', async () => {
  const h = await captureHarness();
  assert.equal((await h.controller.startMeeting()).length, 0);
  assert.deepEqual(Array.from(h.controller.sources, source => source.kind).sort(), ['display', 'microphone']);
});

test('worklet pause flushes its tail and does not capture subsequent input', async () => {
  const source = await readFile(new URL('../apps/web/public/audio-worklet.js',import.meta.url),'utf8');
  let Worklet;const events=[];
  class AudioWorkletProcessor { constructor(){this.port={postMessage:message=>events.push(message)};} }
  vm.runInNewContext(source,{AudioWorkletProcessor,sampleRate:16000,registerProcessor:(_name,type)=>{Worklet=type;}});
  const worklet=new Worklet();
  worklet.process([[new Float32Array(128).fill(0.1)]]);
  worklet.port.onmessage({data:{type:'pause'}});
  assert.deepEqual(events.map(event=>event.type),['pcm','flushed']);
  assert.equal(events[0].buffer.byteLength,256);
  for(let i=0;i<60;i++)worklet.process([[new Float32Array(128).fill(0.2)]]);
  assert.equal(events.length,2);
});


test('ending a shared video track leaves both audio sources recording', async () => {
  const h = await captureHarness({displayVideo:true});
  await h.controller.startMeeting();
  h.display.videoTrack.readyState = 'ended';
  h.display.videoTrack.handlers.ended?.();
  assert.equal(h.ended.length, 0, 'video completion must not pause a meeting');
  assert.equal(h.controller.active, true);
  assert.equal(h.controller.sources.length, 2);
  await h.controller.stop();
});

test('lost browser audio source drains its saved tail and leaves the other source recording', async () => {
  const h = await captureHarness();
  await h.controller.startMeeting();
  const index = h.controller.sources.findIndex(source => source.kind === 'display');
  const node = h.nodes[index];
  node.port.onmessage({data:{type:'pcm',buffer:new ArrayBuffer(320)}});
  h.display.audioTrack.readyState = 'ended';
  h.display.audioTrack.handlers.ended();
  for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.ended.length, 0, 'one lost source must not pause the meeting');
  assert.equal(h.controller.active, true);
  assert.equal(h.controller.sources.length, 1);
  assert.equal(h.controller.sources[0].kind, 'microphone');
  assert.equal(h.uploads.length, 1, 'already captured audio must remain durable');
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].continuing, true);
  await h.controller.stop();
});

test('a recoverable source interruption reports a bubble without pausing or sealing capture', async () => {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url),'utf8');
  const fragment = app.slice(app.indexOf('  function controllerFor('),app.indexOf('  async function quickRecord('));
  const code = (await transform(fragment+'\nexports.factory=controllerFor;', {loader:'ts'})).code;
  const state={stops:[],error:'',recording:true};
  class Controller { constructor(...args) { this.args=args;this.active=true; } }
  const sandbox={exports:{},CaptureController:Controller,capture:{current:{active:true}},setRecording:v=>state.recording=v,setError:v=>state.error=v,
    messageOf:e=>e.message,stopCapture:async(...args)=>state.stops.push(args),upload(){},setSignals(){}};
  vm.runInNewContext(code,sandbox);
  const controller=sandbox.exports.factory('r');
  sandbox.capture.current=controller;
  controller.args[2](new Error('会议声音中断'),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(state.stops,[]);
  assert.equal(state.recording,true);
  assert.equal(state.error,'会议声音中断');
});


test('an interruption from an old controller cannot pause a newer meeting', async () => {
  const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
  const code=(await transform(app.slice(app.indexOf('  function controllerFor('),app.indexOf('  async function quickRecord('))+'\nexports.factory=controllerFor;',{loader:'ts'})).code;
  const state={stops:0,errors:0};class Controller{constructor(...args){this.args=args;this.active=true;}}
  const sandbox={exports:{},CaptureController:Controller,capture:{current:null},setRecording(){},setError(){state.errors++;},messageOf:e=>e.message,stopCapture:async()=>{state.stops++;},upload(){},setSignals(){}};
  vm.runInNewContext(code,sandbox);const old=sandbox.exports.factory('old');sandbox.capture.current=sandbox.exports.factory('new');
  old.args[2](new Error('旧音源中断'));old.args[4]();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(state.stops,0);assert.equal(state.errors,0);
});


test('source loss never claims audio was saved after tail persistence fails', async () => {
  const h=await captureHarness({enqueueFailure:true});await h.controller.startMeeting();
  const index=h.controller.sources.findIndex(source=>source.kind==='display'), node=h.nodes[index];
  const original=node.port.postMessage;
  node.port.postMessage=message=>{if(message.type==='pause')node.port.onmessage?.({data:{type:'pcm',buffer:new ArrayBuffer(320)}});original(message);};
  h.display.audioTrack.readyState='ended';h.display.audioTrack.handlers.ended();
  for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.uploads.length,0);
  assert.ok(h.errors.some(({error})=>error.message==='本机存储空间不足'));
  assert.equal(h.errors.some(({continuing})=>continuing===true),false,'failed persistence must not produce a recoverable saved-audio notice');
  await h.controller.stop();
});

for (const minutesMode of ['doubao-audio', 'openai-realtime', 'doubao-audio-only']) test(`quick recording starts without meeting form in ${minutesMode}`, async () => {
  const h = await quickRecordHarness({ active: true, issues: [], minutesMode });
  assert.equal(h.state.starts, 1, `quick click opened ${h.state.modal} instead of starting capture`);
  assert.equal(h.state.recording, true);
  assert.equal(h.state.created.title, undefined);
  assert.equal(h.state.created.autoMinutes, false, 'audio upload needs separate per-meeting consent');
  assert.equal(h.state.created.realtimeAudioConsent, false, 'quick capture cannot grant undisclosed audio upload consent');
});

test('capsule clock uses queued PCM per source without double counting tracks or resumed sessions', async () => {
  const source=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/signal.ts',import.meta.url),'utf8')).replace(/^import .*$/gm,'').replace(/export /g,'');
  const sandbox={exports:{}};vm.runInNewContext(source+'\nexports.clock=capturedDurationMs;',sandbox);
  const clock=sandbox.exports.clock;
  const sources=[{id:'mic',timelineOffsetMs:90000},{id:'display',timelineOffsetMs:90000}];
  assert.equal(clock(110000,sources,[{sourceId:'mic',seconds:30},{sourceId:'display',seconds:32}]),122000);
  assert.equal(clock(122000,sources,[]),122000);
  assert.equal(clock(7000,sources,[{sourceId:'other-record',seconds:500}]),7000);
  assert.equal(clock(0,[{id:'mic'}],[{sourceId:'mic',seconds:1.234567}]),1235);
  assert.equal(clock(0,[{id:'mic',timelineOffsetMs:.5}],[{sourceId:'mic',seconds:1.234567}]),1235);
  assert.equal(clock(1234.6,[],[]),1235);
});


test('full cache stops browser setup before a source or worklet exists and releases permissions',async()=>{
 const h=await captureHarness({capacityFailure:true});const issues=await h.controller.startMeeting();
 assert.equal(issues.length,2);assert.equal(h.controller.active,false);assert.equal(h.controller.sources.length,0);
 assert.equal(h.nodes.length,0);assert.equal(h.contexts.length,0);
 assert.equal(h.display.audioTrack.readyState,'ended');assert.equal(h.mic.audioTrack.readyState,'ended');
 assert.equal(h.errors.length,0);
});

test('persistence failure is visible while stop is still waiting for retained audio',async()=>{
 const app=await readFile(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
 const code=(await transform(app.slice(app.indexOf('  function controllerFor('),app.indexOf('  async function quickRecord('))+'\nexports.factory=controllerFor;',{loader:'ts'})).code;
 let release;const held=new Promise(resolve=>{release=resolve;});const state={error:'',recording:true};
 class Controller{constructor(...args){this.args=args;this.active=true;}}
 const sandbox={exports:{},CaptureController:Controller,capture:{current:null},setRecording:v=>state.recording=v,setError:v=>state.error=v,messageOf:e=>e.message,
  stopCapture:()=>{state.error='';return held;},upload(){},setSignals(){}};
 vm.runInNewContext(code,sandbox);const controller=sandbox.exports.factory('r');sandbox.capture.current=controller;
 try{controller.args[2](new Error('本机缓存已满，正在保留未确认音频'));assert.equal(state.recording,false);assert.match(state.error,/本机缓存已满/);}
 finally{release();await new Promise(resolve=>setImmediate(resolve));}
});

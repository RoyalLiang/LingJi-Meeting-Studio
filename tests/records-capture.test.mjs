import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function captureHarness({ noDisplayAudio = false, micFailure = false, displayDenied = false, displayUnsupported = false, recordId = 'record', chunkWait } = {}) {
  let source = await readFile(new URL('../apps/web/src/audio/capture.ts', import.meta.url), 'utf8');
  source = stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^import .*$/gm, '').replace(/export /g, '');
  const signalSource = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/signal.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
  const health = [], nodes = [], calls = [], contexts = [], uploads = []; let sourceNumber = 0;
  const track = label => ({ label, enabled: true, muted: false, readyState: 'live', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, stop() { this.readyState = 'ended'; } });
  const stream = (label, audio = true) => { const audioTrack = track(label); return { audioTrack, getAudioTracks: () => audio ? [audioTrack] : [], getTracks: () => [audioTrack] }; };
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
    preferredDevice: () => 'default', inputDevices: async () => [], microphoneConstraints: () => ({}),
    api: async (_url, _method, input) => ({ id: `source-${input.kind}-${++sourceNumber}`, sessionId: 'session', epoch: 'epoch', ...input }),
    makeChunk: async (...args) => { await chunkWait; return { sourceId: args[0], sequence: args[2], sampleOffset: args[3], buffer: args[4] }; }, enqueue: async (_id, chunk) => uploads.push(chunk), drainQueue: async () => {},
  };
  sandbox.openMicrophone = () => sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  vm.runInNewContext(signalSource + '\n' + source + '\nexports.CaptureController = CaptureController;', sandbox);
  const controller = new sandbox.exports.CaptureController(recordId, () => {}, () => {}, () => {}, () => {}, sources => health.push(structuredClone(sources)));
  return { controller, nodes, health, calls, contexts, mic, display, uploads };
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

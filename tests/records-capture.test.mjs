import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function captureHarness({ noDisplayAudio = false, micFailure = false, displayDenied = false, displayUnsupported = false } = {}) {
  let source = await readFile(new URL('../apps/web/src/audio/capture.ts', import.meta.url), 'utf8');
  source = stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^import .*$/gm, '').replace(/export /g, '');
  const signalSource = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/signal.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
  const health = [], nodes = [], calls = [], contexts = [], uploads = [];
  const track = label => ({ label, enabled: true, muted: false, readyState: 'live', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, stop() { this.readyState = 'ended'; } });
  const stream = (label, audio = true) => { const audioTrack = track(label); return { audioTrack, getAudioTracks: () => audio ? [audioTrack] : [], getTracks: () => [audioTrack] }; };
  const mic = stream('测试麦克风'), display = stream('测试共享音频', !noDisplayAudio);
  class AudioContext {
    constructor() { this.state = 'suspended'; this.handlers = {}; contexts.push(this); this.audioWorklet = { addModule: async () => {} }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    createMediaStreamSource() { return { connect: () => ({ connect: () => ({ connect() {} }) }) }; }
    createGain() { return { gain: { value: 1 } }; }
  }
  class AudioWorkletNode { constructor() { this.port = { postMessage() {} }; nodes.push(this); } }
  const sandbox = { exports: {}, AudioContext, AudioWorkletNode, DOMException, Error, window: { setTimeout, clearTimeout, isSecureContext: true }, setTimeout, clearTimeout,
    navigator: { mediaDevices: {
      getUserMedia: async () => { calls.push('microphone'); if (micFailure) throw new Error('麦克风权限被拒绝'); return mic; },
      getDisplayMedia: displayUnsupported ? undefined : async options => { calls.push({ display: options }); if (displayDenied) throw new DOMException('Permission denied', 'NotAllowedError'); return display; },
    } },
    preferredDevice: () => 'default', inputDevices: async () => [], microphoneConstraints: () => ({}),
    api: async (_url, _method, input) => ({ id: `source-${input.kind}`, sessionId: 'session', epoch: 'epoch', ...input }),
    makeChunk: async (...args) => ({ buffer: args[4] }), enqueue: async (_id, chunk) => uploads.push(chunk), drainQueue: async () => {},
  };
  sandbox.openMicrophone = () => sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  vm.runInNewContext(signalSource + '\n' + source + '\nexports.CaptureController = CaptureController;', sandbox);
  const controller = new sandbox.exports.CaptureController('record', () => {}, () => {}, () => {}, () => {}, sources => health.push(structuredClone(sources)));
  return { controller, nodes, health, calls, contexts, mic, display, uploads };
}

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

test('meeting capture requests shared audio in the user gesture and keeps independent microphone input', async () => {
  const h = await captureHarness();
  const started = h.controller.startMeeting();
  assert.ok(h.calls[0]?.display, 'display permission must start before yielding the gesture');
  await started;
  assert.deepEqual(Array.from(h.controller.sources, s => s.kind), ['display', 'microphone']);
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

test('microphone denial after shared capture preserves the working source and explains partial capture', async () => {
  const h = await captureHarness({ micFailure: true });
  const issues = await h.controller.startMeeting();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'microphone');
  assert.match(issues[0].message, /麦克风|denied/i);
  assert.equal(h.controller.active, true);
  assert.equal(h.controller.sources.length, 1);
});

test('missing shared audio still connects microphone and can retry without duplicating it', async () => {
  const h = await captureHarness({ noDisplayAudio: true });
  const issues = await h.controller.startMeeting();
  assert.deepEqual(Array.from(issues, issue => issue.kind), ['display']);
  assert.equal(h.controller.active, true);
  assert.deepEqual(Array.from(h.controller.sources, source => source.kind), ['microphone']);
  await h.controller.startMeeting();
  assert.equal(h.calls.filter(call => call === 'microphone').length, 1);
  assert.equal(h.controller.sources.length, 1);
  assert.equal(h.mic.audioTrack.readyState, 'live');
});

test('denied sharing still captures the microphone; unavailable sharing reports a recoverable issue', async () => {
  for (const options of [{displayDenied:true}, {displayUnsupported:true}]) {
    const h = await captureHarness(options);
    const issues = await h.controller.startMeeting();
    assert.deepEqual(Array.from(issues, issue => issue.kind), ['display']);
    assert.equal(h.controller.active, true);
    assert.equal(h.controller.sources[0].kind, 'microphone');
    assert.match(issues[0].message, /会议音频/);
  }
});

test('when both inputs fail the meeting reports both issues without recording', async () => {
  const h = await captureHarness({ noDisplayAudio:true, micFailure:true });
  const issues = await h.controller.startMeeting();
  assert.deepEqual(Array.from(issues, issue => issue.kind), ['display', 'microphone']);
  assert.equal(h.controller.active, false);
  assert.equal(h.controller.sources.length, 0);
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

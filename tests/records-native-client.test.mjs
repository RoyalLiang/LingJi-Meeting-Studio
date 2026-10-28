import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/native-stream.ts', import.meta.url), 'utf8'));
const { decodeNativePacket, openNativeStream } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function packet(sequence, offset, count = 320) {
  const raw = new ArrayBuffer(12 + count * 2), view = new DataView(raw);
  view.setUint32(0, sequence, true); view.setUint32(4, offset, true); view.setUint32(8, count, true);
  for (let n = 0; n < count; n++) view.setInt16(12 + n * 2, 1000, true);
  return raw;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('widget initial snapshot cannot overwrite a newer recording event',async()=>{
 const {transform}=await import('esbuild');
 const source=await readFile(new URL('../apps/web/src/components/RecordingWidget.tsx',import.meta.url),'utf8');
 const code=(await transform(source.replace(/^import .*$/gm,''),{loader:'tsx',format:'cjs'})).code;
 const states=[],effects=[],layouts=[],calls=[],actionInputs=[];let cursor=0,receive,resolveSnapshot;
 const snapshot=new Promise(resolve=>{resolveSnapshot=resolve;}),icon=()=>null;
 const sandbox={useRecordingDuration:(_id,savedMs)=>savedMs,module:{exports:{}},useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],value=>{states[i]=value;}];},useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>layouts.push(fn),
  listen:async(_name,handler)=>{receive=handler;return()=>{};},invoke:async(name,input)=>{calls.push(name);if(name==='recording_widget_action')actionInputs.push(input);return name==='recording_widget_state'?snapshot:undefined;},Pause:icon,Play:icon,Stop:icon,ArrowsOutSimple:icon,Microphone:icon,MicrophoneSlash:icon};
 sandbox.React={createElement:(tag,props,...children)=>({tag,props,children})};
 vm.runInNewContext(code,sandbox);sandbox.module.exports.RecordingWidget();effects[0]();await tick();
 receive({payload:{recording:true,microphoneOn:true,paused:false,canResume:false,busy:false,durationMs:2000,rms:.1}});
 resolveSnapshot({recording:false,paused:false,canResume:false,busy:false,durationMs:0,rms:0});await tick();
 assert.equal(states[0].recording,true);assert.equal(states[0].durationMs,2000);
 cursor=0;const tree=sandbox.module.exports.RecordingWidget();layouts.forEach(fn=>fn());await tick();
 assert.ok(calls.includes('recording_widget_ready'));
 const nodes=value=>value&&typeof value==='object'?[value,...(value.children||[]).flat(Infinity).flatMap(nodes)]:[];
 const microphone=nodes(tree).find(node=>node.props?.['aria-label']==='关闭麦克风');
 assert.ok(microphone);assert.equal(microphone.props['aria-pressed'],true);assert.equal(microphone.props.disabled,false);
 microphone.props.onClick();await tick();assert.equal(actionInputs.at(-1).action,'microphone');
 const native=await readFile(new URL('../apps/desktop/src-tauri/src/main.rs',import.meta.url),'utf8');
 for(const action of ['pause','finish','restore']){
  const selector=native.match(new RegExp('"'+action+'" => Some\\((.*?)\\),'))?.[1]||'';
  const labels=[...selector.matchAll(/\[aria-label="([^"]+)"\]/g)].map(match=>match[1]);
  const button=nodes(tree).find(node=>labels.includes(node.props?.['aria-label']));
  assert.ok(button,`Native ${action} probe must target the rendered accessible button`);
  button.props.onClick();await tick();assert.equal(actionInputs.at(-1).action,action);
 }
});

test('native packets enforce sequence, offset, sample count and binary length', () => {
  const decoded = decodeNativePacket(packet(0, 0), 0, 0);
  assert.equal(decoded.buffer.byteLength, 640);
  for (const raw of [packet(1, 0), packet(0, 3), packet(0, 0, 0), packet(0, 0, 16001), new ArrayBuffer(4)]) {
    assert.throws(() => decodeNativePacket(raw, 0, 0));
  }
});

test('native pull applies disk backpressure and stop drains the final packet exactly once', async () => {
  let persist, reads = 0, stopping = false, stops = 0; const saved = [];
  const invoke = async command => {
    if (command === 'capture_ack') return;
    if (command === 'capture_start') return { id: 'one', label: 'synthetic' };
    if (command === 'capture_stop') { stops++; stopping = true; return; }
    reads++; if (reads === 1) return packet(0, 0);
    assert.equal(stopping, true); return reads === 2 ? packet(1, 320, 50) : new ArrayBuffer(0);
  };
  const stream = await openNativeStream(invoke, 'display', 'default', async next => {
    saved.push(next); if (next.sequence === 0) await new Promise(resolve => { persist = resolve; });
  }, error => assert.fail(error));
  await tick(); assert.equal(reads, 1);
  const first = stream.stop(), second = stream.stop(); persist(); await Promise.all([first, second]);
  assert.equal(stops, 1); assert.equal(reads, 3); assert.deepEqual(saved.map(x => [x.sequence, x.sampleOffset, x.buffer.byteLength]), [[0, 0, 640], [1, 320, 100]]);
});

test('disconnect drops later packets and never silently changes to another source', async () => {
  let release, stopping = false, saved = 0;
  const invoke = async command => {
    if (command === 'capture_start') return { id: 'mic', label: 'synthetic' };
    if (command === 'capture_stop') { stopping = true; release(packet(0, 0)); return; }
    if (stopping) return new ArrayBuffer(0);
    return new Promise(resolve => { release = resolve; });
  };
  const stream = await openNativeStream(invoke, 'microphone', 'chosen-device', async () => { saved++; }, assert.fail);
  await stream.stop(true); assert.equal(saved, 0);
});

test('native permission/device failures do not create a simulated stream', async () => {
  const commands = [];
  await assert.rejects(openNativeStream(async command => { commands.push(command); throw new Error('permission denied'); }, 'display', 'default', async () => {}, assert.fail), /permission denied/);
  assert.deepEqual(commands, ['capture_start']);
});

async function controllerHarness({ beforeStart, capacityFailure = false } = {}) {
  const starts = [], uploads = [], sessions = new Map(); let sourceId = 0;
  const invoke = async (command, args) => {
    if (command === 'capture_start') {
      const id = `native-${starts.length}`; starts.push(args); await beforeStart?.(args); sessions.set(id, { reads: 0, stopped: false }); return { id, label: 'synthetic' };
    }
    const session = sessions.get(args.id);
    if (command === 'capture_read') {
      session.reads++; if (session.reads === 1) return packet(0, 0);
      if (session.stopped) return new ArrayBuffer(0);
      return new Promise((resolve,reject) => { session.release = resolve; session.reject=reject; });
    }
    if (command === 'capture_stop') { session.stopped = true; session.release?.(args.discard ? new ArrayBuffer(0) : packet(1, 320, 80)); }
  };
  globalThis.nativeControllerFixture = {
    ensureAudioCapacity: async () => { if(capacityFailure) throw new Error("本机录音缓存空间不足，尚未开始录音"); },
    api: async (_url, _method, body) => ({ id: `source-${sourceId++}`, sessionId: 'session', epoch: `epoch-${sourceId}`, ...body }),
    enqueue: async (id, chunk) => uploads.push({ id, chunk }),
    makeChunk: async (id, epoch, sequence, offset, buffer, sessionId) => ({ sourceId: id, epoch, sequence, sampleOffset: offset, sampleCount: buffer.byteLength / 2, sessionId }),
    startNativeStream: (kind, device, onPacket, onError) => openNativeStream(invoke, kind, device, onPacket, onError),
  };
  const signalCode = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/signal.ts', import.meta.url), 'utf8'));
  const signalUrl = `data:text/javascript;base64,${Buffer.from(signalCode).toString('base64')}`;
  let code = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/native-controller.ts', import.meta.url), 'utf8'));
  code = code.replace("import { preferredDevice } from './devices';", "const preferredDevice = () => 'default';")
    .replace("import { api } from '../api';", 'const { api } = globalThis.nativeControllerFixture;')
    .replace("import { enqueue, makeChunk, ensureAudioCapacity } from './queue';", 'const { enqueue, makeChunk, ensureAudioCapacity } = globalThis.nativeControllerFixture;')
    .replace("from './signal'", `from '${signalUrl}'`)
    .replace("import { startNativeStream } from './native-runtime';", 'const { startNativeStream } = globalThis.nativeControllerFixture;');
  const module = await import(`data:text/javascript;base64,${Buffer.from(code + `\n// fixture ${Math.random()}`).toString('base64')}`);
  const errors = [];
  const controller = new module.NativeCaptureController('record', () => {}, error => errors.push(error), () => {}, () => {});
  return { controller, starts, uploads, errors, sessions };
}

test('native controller deduplicates starts and defaults to system output plus microphone', async () => {
  const h = await controllerHarness();
  assert.deepEqual(await Promise.all([h.controller.startMeeting(), h.controller.startMeeting()]), [[], []]);
  await tick(); assert.deepEqual(h.starts.map(x => x.kind), ['display', 'microphone']);
  await h.controller.stop(); assert.equal(h.controller.active, false);
  assert.equal(new Set(h.uploads.map(upload => upload.chunk.sourceId)).size, 2);
  for (const sourceId of new Set(h.uploads.map(upload => upload.chunk.sourceId))) assert.deepEqual(h.uploads.filter(upload => upload.chunk.sourceId === sourceId).map(x => [x.chunk.sequence, x.chunk.sampleOffset, x.chunk.sampleCount]), [[0, 0, 320], [1, 320, 80]]);
});

test('native microphone disconnect preserves the other lane and reopens with a fresh Source', async () => {
  const h = await controllerHarness(); await h.controller.startMeeting();
  const first = await h.controller.start('microphone', 'device-one'); await tick();
  await h.controller.disconnect('microphone');
  assert.equal(h.controller.active, true); assert.deepEqual(h.controller.sources.map(x => x.kind), ['display']);
  assert.equal(h.uploads.filter(x => x.chunk.sourceId === first.id).length, 1);
  const reopened = await h.controller.start('microphone', 'device-two'); assert.notEqual(first.id, reopened.id);
  await tick(); await h.controller.stop();
  assert.equal(h.errors.length, 0);
  assert.equal(h.uploads.filter(x => x.chunk.sourceId === reopened.id).length, 2);
});

test('native pause drains and releases audio, resume creates new sources for explicitly enabled lanes', async () => {
  const h = await controllerHarness();
  await h.controller.startMeeting(); await h.controller.start('microphone', 'device-one');
  const before = h.controller.sources.map(source => source.id);
  await h.controller.pause(); assert.equal(h.controller.active, false);
  assert.equal(h.uploads.filter(upload => upload.chunk.sequence === 1).length, 2);
  assert.deepEqual(await h.controller.startMeeting(), []);
  assert.deepEqual(h.starts.map(start => start.kind), ['display', 'microphone', 'display', 'microphone']);
  assert.ok(h.controller.sources.every(source => !before.includes(source.id)));
  await h.controller.stop();
});

test('native reconnect preserves explicit microphone-off and surfaces revoked OS access without creating another source', async () => {
  let allowed = true;
  const h = await controllerHarness({ beforeStart: () => { if (!allowed) throw new Error('fixture OS audio access revoked'); } });
  await h.controller.startMeeting(); await tick(); await h.controller.disconnect('microphone'); await h.controller.pause();
  await h.controller.startMeeting(); await tick();
  assert.deepEqual(h.starts.map(start => start.kind), ['display', 'microphone', 'display']);
  assert.deepEqual(h.controller.sources.map(source => source.kind), ['display']);
  await h.controller.pause(); const saved = h.uploads.length;
  allowed = false;
  assert.deepEqual(await h.controller.startMeeting(), [{ kind: 'display', message: 'fixture OS audio access revoked' }]);
  assert.equal(h.controller.active, false); assert.equal(h.controller.sources.length, 0); assert.equal(h.uploads.length, saved);
  assert.deepEqual(h.starts.map(start => start.kind), ['display', 'microphone', 'display', 'display']);
  await h.controller.stop();
});

test('native resume restores only successful prior lanes even under repeated concurrent resume clicks', async () => {
  const h = await controllerHarness({ beforeStart: ({ kind }) => { if (kind === 'microphone') throw new Error('fixture microphone denied'); } });
  assert.deepEqual(await h.controller.startMeeting(), [{ kind: 'microphone', message: 'fixture microphone denied' }]);
  assert.equal(h.controller.active, true); assert.deepEqual(h.controller.sources.map(source => source.kind), ['display']);
  await h.controller.pause();
  assert.deepEqual(await Promise.all([h.controller.startMeeting(), h.controller.startMeeting()]), [[], []]);
  assert.deepEqual(h.starts.map(start => start.kind), ['display', 'microphone', 'display']);
  await h.controller.stop();
});

test('native microphone-off persists across repeated starts and an empty paused selection never falls back to other lanes', async () => {
  const h = await controllerHarness();
  await h.controller.startMeeting(); await h.controller.disconnect('microphone');
  await h.controller.startMeeting(); await h.controller.pause(); await h.controller.startMeeting();
  assert.deepEqual(h.starts.map(start => start.kind), ['display', 'microphone', 'display']);
  await h.controller.stop();
  const onlyMicrophone = await controllerHarness({ beforeStart: ({ kind }) => { if (kind === 'display') throw new Error('fixture system audio denied'); } });
  assert.deepEqual(await onlyMicrophone.controller.startMeeting(), [{ kind: 'display', message: 'fixture system audio denied' }]);
  await onlyMicrophone.controller.pause(); await onlyMicrophone.controller.disconnect('microphone');
  assert.deepEqual(await onlyMicrophone.controller.startMeeting(), []); assert.deepEqual(await onlyMicrophone.controller.startMeeting(), []);
  assert.deepEqual(onlyMicrophone.starts.map(start => start.kind), ['display', 'microphone']); assert.equal(onlyMicrophone.controller.active, false);
  await onlyMicrophone.controller.stop();
});

test('native smoke probe validates both queued source identities, contiguous samples, audio hashes and manifests independently', async () => {
  const source = await readFile(new URL('../apps/desktop/src-tauri/src/probe.js', import.meta.url), 'utf8');
  const context = { crypto: webcrypto, atob, Uint8Array, Int16Array };
  vm.runInNewContext(source.slice(0, source.indexOf('(async () =>')), context);
  const record = { sources: ['display', 'microphone'].map(kind => ({ id: kind, kind, sessionId: `session-${kind}`, epoch: `epoch-${kind}`, lastSequence: 1, stopped: true })) }, queued = [];
  for (const lane of record.sources) for (let sequence = 0; sequence < 2; sequence++) {
    const bytes = Buffer.alloc(640, 1), digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
    queued.push({ chunk: { sourceId: lane.id, sessionId: lane.sessionId, epoch: lane.epoch, sequence, sampleOffset: sequence * 320, sampleCount: 320, sampleRate: 16000, pcm: bytes.toString('base64'), digest } });
  }
  const report = await context.verifyNativeUiLanes(record, queued);
  assert.deepEqual(Array.from(report, lane => [lane.kind, lane.packets, lane.samples]), [['display', 2, 640], ['microphone', 2, 640]]);
  for (const mutate of [
    (r) => { r.sources[1].lastSequence = 2; },
    (_r, q) => { q[2].chunk.sampleOffset = 9; },
    (_r, q) => { q[2].chunk.sequence = 9; },
    (_r, q) => { q[2].chunk.epoch = 'other-epoch'; },
    (_r, q) => { q[2].chunk.digest = 'wrong-digest'; },
    (_r, q) => { q[2].chunk.sampleCount = 1; },
    (r) => { r.sources.pop(); },
  ]) {
    const badRecord = structuredClone(record), badQueue = structuredClone(queued); mutate(badRecord, badQueue);
    await assert.rejects(context.verifyNativeUiLanes(badRecord, badQueue));
  }
});

test('unexpected native end reports interruption instead of silently finishing recording', async () => {
  const errors = [], commands = [];
  const stream = await openNativeStream(async command => {
    commands.push(command);
    return command === 'capture_start' ? { id: 'unexpected-end', label: 'synthetic' } : new ArrayBuffer(0);
  }, 'microphone', 'default', async () => {}, error => errors.push(error));
  await assert.rejects(stream.done, /意外停止/);
  assert.equal(errors.length, 1);
  assert.equal(commands.at(-1), 'capture_stop');
});

test('native capture keeps consecutive audio beyond thirty minutes until explicit stop', async () => {
  const saved = [], errors = [];
  let sequence = 0, stopping = false;
  const count = 16000, total = 35 * 60;
  const stream = await openNativeStream(async command => {
    if (command === 'capture_ack') return;
    if (command === 'capture_start') return { id: 'long-capture', label: 'synthetic' };
    if (command === 'capture_stop') { stopping = true; return; }
    if (stopping) return new ArrayBuffer(0);
    assert.ok(sequence < total, 'capture must be stopped explicitly');
    return packet(sequence, sequence++ * count, count);
  }, 'display', 'default', async next => {
    saved.push([next.sequence, next.sampleOffset]);
    if (saved.length === total) queueMicrotask(() => { void stream.stop(); });
  }, error => errors.push(error));
  await stream.done;
  assert.equal(saved.length, total);
  assert.deepEqual(saved.at(-1), [total - 1, (total - 1) * count]);
  assert.deepEqual(errors, []);
});


test('native device failure leaves the other source recording and lets the lost source reconnect', async () => {
  const h=await controllerHarness();await h.controller.startMeeting();
  for(let i=0;i<6;i++)await tick();
  h.sessions.get('native-0').reject(new Error('系统音频设备中断'));
  for(let i=0;i<12;i++)await tick();
  assert.equal(h.controller.active,true);
  assert.equal(h.controller.sources.length,1);
  assert.equal(h.controller.sources[0].kind,'microphone');
  assert.equal(h.errors.length,1);
  await h.controller.start('display');
  assert.equal(h.controller.sources.length,2);
  await h.controller.stop();
});

test('a local persistence failure retains and retries the native head and all queued tail packets', async () => {
  const saved=[], stops=[];let head=0, attempts=0;
  const invoke=async(command,args)=>{
    if(command==='capture_start')return{id:'retained',label:'synthetic'};
    if(command==='capture_stop'){stops.push(args.discard);return;}
    if(command==='capture_ack'){assert.equal(args.sequence,head);head++;return;}
    if(command==='capture_read')return head<3?packet(head,head*320):new ArrayBuffer(0);
  };
  const stream=await openNativeStream(invoke,'microphone','default',async value=>{
    if(++attempts===1)throw new Error('temporary local capacity failure');
    saved.push(value.sequence);
  },()=>{});
  await assert.doesNotReject(stream.stop());
  assert.deepEqual(saved,[0,1,2]);assert.ok(stops.every(discard=>discard===false));assert.equal(head,3);
});

test('intentional disconnect during local persistence never ACKs a discarded session',async()=>{
  let release,entered;const gate=new Promise(r=>{release=r;});const ready=new Promise(r=>{entered=r;});const errors=[],acks=[];
  const stream=await openNativeStream(async(command,args)=>{
    if(command==='capture_start')return{id:'discarded',label:'synthetic'};
    if(command==='capture_read')return packet(0,0);
    if(command==='capture_ack'){acks.push(args);throw new Error('session was removed');}
  },'microphone','default',async()=>{entered();await gate;},e=>errors.push(e));
  await ready;const stopped=stream.stop(true);release();await stopped;
  assert.deepEqual(errors,[]);assert.deepEqual(acks,[]);
});

test('a lost ACK response retries only the same ACK without saving the audio twice',async()=>{
 let head=0,acks=0;const saved=[];
 const stream=await openNativeStream(async(command,args)=>{
   if(command==='capture_start')return{id:'lost-ack',label:'synthetic'};
   if(command==='capture_read')return head===0?packet(0,0):new ArrayBuffer(0);
   if(command==='capture_ack'){acks++;assert.equal(args.sequence,0);if(acks===1){head=1;throw new Error('ACK response lost');}}
 },'microphone','default',async value=>saved.push(value.sequence),()=>{});
 await stream.stop();assert.deepEqual(saved,[0]);assert.equal(acks,2);assert.equal(head,1);
});


test('full cache refuses native capture before starting audio producers',async()=>{
 const h=await controllerHarness({capacityFailure:true});const issues=await h.controller.startMeeting();
 assert.equal(issues.length,2);assert.equal(h.controller.active,false);assert.equal(h.starts.length,0);assert.equal(h.uploads.length,0);
});

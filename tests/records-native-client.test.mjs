import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/audio/native-stream.ts', import.meta.url), 'utf8'));
const { decodeNativePacket, openNativeStream } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function packet(sequence, offset, count = 320) {
  const raw = new ArrayBuffer(12 + count * 2), view = new DataView(raw);
  view.setUint32(0, sequence, true); view.setUint32(4, offset, true); view.setUint32(8, count, true);
  for (let n = 0; n < count; n++) view.setInt16(12 + n * 2, 1000, true);
  return raw;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

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

test('native persistence errors stop capture and surface the original failure', async () => {
  const calls = [], errors = []; const full = new Error('local_audio_capacity_exceeded');
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'capture_start') return { id: 'one', label: 'synthetic' };
    if (command === 'capture_read') return packet(0, 0);
  };
  const stream = await openNativeStream(invoke, 'display', 'default', async () => { throw full; }, error => errors.push(error));
  await assert.rejects(stream.done, error => error === full);
  assert.equal(errors[0], full); assert.deepEqual(calls.at(-1), ['capture_stop', { id: 'one', discard: true }]);
});

test('native permission/device failures do not create a simulated stream', async () => {
  const commands = [];
  await assert.rejects(openNativeStream(async command => { commands.push(command); throw new Error('permission denied'); }, 'display', 'default', async () => {}, assert.fail), /permission denied/);
  assert.deepEqual(commands, ['capture_start']);
});

async function controllerHarness() {
  const starts = [], uploads = [], sessions = new Map(); let sourceId = 0;
  const invoke = async (command, args) => {
    if (command === 'capture_start') {
      const id = `native-${starts.length}`; starts.push(args); sessions.set(id, { reads: 0, stopped: false }); return { id, label: 'synthetic' };
    }
    const session = sessions.get(args.id);
    if (command === 'capture_read') {
      session.reads++; if (session.reads === 1) return packet(0, 0);
      if (session.stopped) return new ArrayBuffer(0);
      return new Promise(resolve => { session.release = resolve; });
    }
    if (command === 'capture_stop') { session.stopped = true; session.release?.(args.discard ? new ArrayBuffer(0) : packet(1, 320, 80)); }
  };
  globalThis.nativeControllerFixture = {
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
    .replace("import { enqueue, makeChunk } from './queue';", 'const { enqueue, makeChunk } = globalThis.nativeControllerFixture;')
    .replace("from './signal'", `from '${signalUrl}'`)
    .replace("import { startNativeStream } from './native-runtime';", 'const { startNativeStream } = globalThis.nativeControllerFixture;');
  const module = await import(`data:text/javascript;base64,${Buffer.from(code + `\n// fixture ${Math.random()}`).toString('base64')}`);
  const errors = [];
  const controller = new module.NativeCaptureController('record', () => {}, error => errors.push(error), () => {}, () => {});
  return { controller, starts, uploads, errors };
}

test('native controller deduplicates starts and defaults to system output only', async () => {
  const h = await controllerHarness();
  assert.deepEqual(await Promise.all([h.controller.startMeeting(), h.controller.startMeeting()]), [[], []]);
  await tick(); assert.deepEqual(h.starts.map(x => x.kind), ['display']);
  await h.controller.stop(); assert.equal(h.controller.active, false);
  assert.deepEqual(h.uploads.map(x => [x.chunk.sequence, x.chunk.sampleOffset, x.chunk.sampleCount]), [[0, 0, 320], [1, 320, 80]]);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function stopHarness({ backgroundWait = Promise.resolve(), refreshFails = false } = {}) {
  const app = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  async function stopCapture('), end = app.indexOf('  function captureAllowed(', start);
  assert.ok(start >= 0 && end > start);
  const code = (await transform(app.slice(start, end) + '\nexports.stopCapture = stopCapture;', { loader: 'ts' })).code;
  const current = { id: 'meeting', title: '会议', capture: 'recording', sources: [{ id: 'mic', epoch: 'epoch', watermark: 0 } ] };
  const state = { busy: false, phase: 'idle', recording: true, record: current, modal: 'finish', error: '', calls: [] };
  const controller = { active: true, async stop() { this.active = false; state.calls.push('local-stop'); } };
  const sandbox = {
    exports: {}, stopping: { current: false }, capture: { current: controller }, activeId: { current: current.id },
    setBusy: value => { state.busy = value; }, setCapturePhase: value => { state.phase = value; },
    setError: value => { state.error = value; }, setRecording: value => { state.recording = value; },
    setRecord: value => { state.record = value; }, setModal: value => { state.modal = value; },
    api: async (path, method, body) => { state.calls.push({ path, method, body }); return method === 'POST' ? { ...current, capture: 'sealed' } : current; },
    localManifests: async () => [{ sourceId: 'mic', lastSequence: 3 }],
    upload: () => backgroundWait,
    refresh: async () => { if (refreshFails) throw new Error('refresh unavailable'); },
    loadList: async () => {}, showToast: value => { state.toast = value; }, messageOf: error => error.message,
    AbortSignal, Promise, console,
  };
  vm.runInNewContext(code, sandbox);
  return { state, ...sandbox.exports };
}

test('ending a meeting releases the controls after sealing even while background audio upload is pending', async () => {
  let release;
  const backgroundWait = new Promise(resolve => { release = resolve; });
  const h = await stopHarness({ backgroundWait });
  let ended = false;
  const stopping = h.stopCapture().then(value => { ended = value; });
  await tick(); await tick();
  try {
    assert.equal(h.state.record.capture, 'sealed');
    assert.equal(ended, true, 'a durable sealed meeting must not wait on background upload');
    assert.equal(h.state.busy, false);
    assert.equal(h.state.modal, null);
    assert.equal(h.state.recording, false);
    assert.equal(h.state.phase, 'idle');
    assert.equal(h.state.calls.find(call => call.method === 'POST').body.sources[0].lastSequence, 3, 'seal preserves the locally saved tail watermark');
  } finally { release(); await stopping; }
});

test('a failed refresh after a successful seal cannot report the meeting as unfinished', async () => {
  const h = await stopHarness({ refreshFails: true });
  assert.equal(await h.stopCapture(), true);
  assert.equal(h.state.record.capture, 'sealed');
  assert.equal(h.state.busy, false);
});

async function renderControls(props) {
  const source = await readFile(new URL('../apps/web/src/components/MeetingControls.tsx', import.meta.url), 'utf8');
  const code = (await transform(source.replace(/^import .*$/gm, '').replace('export function', 'function') + '\nexports.render = MeetingControls;', { loader: 'tsx' })).code;
  const element = (tag, attributes, ...children) => ({ tag: typeof tag === 'string' ? tag : 'component', attributes, children });
  const sandbox = { exports: {}, React: { createElement: element, Fragment: 'fragment' }, Button() {}, CaptureSignals() {} };
  for (const icon of ['Headphones','Microphone','MicrophoneSlash','Play','Plus','Record','Square','FileAudio']) sandbox[icon] = () => {};
  vm.runInNewContext(code, sandbox);
  return JSON.stringify(sandbox.exports.render({ record: { capture: 'recording', sources: [] }, ready: true, signals: [], ...props }));
}

test('meeting controls distinguish ending capture from starting audio or unrelated page work', async () => {
  const ending = await renderControls({ recording: false, busy: true, phase: 'stopping' });
  assert.doesNotMatch(ending, /正在接入声音/);
  assert.match(ending, /正在收尾/);
  const saving = await renderControls({ recording: false, busy: true, phase: 'idle' });
  assert.doesNotMatch(saving, /正在接入声音/);
  const starting = await renderControls({ recording: false, busy: true, phase: 'starting' });
  assert.match(starting, /正在接入声音/);
});

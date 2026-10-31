import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

async function harness() {
  const code = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/useNativeMenuBar.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
  const refs = [], calls = [], actions = [], timers = [];
  let handler, cleanup, removed = false;
  const sandbox = { exports: {},
    useRef: current => { const ref = { current }; refs.push(ref); return ref; },
    useEffect: effect => { cleanup = effect(); },
    isTauri: () => true,
    pendingCount: async () => 7,
    invoke: async (command, input) => calls.push({ command, input: structuredClone(input) }),
    listen: async (_name, listener) => { handler = listener; return () => { removed = true; }; },
    window: { setInterval: callback => { timers.push(callback); return 1; } }, clearInterval() {}
  };
  vm.runInNewContext(code + '\nexports.useNativeMenuBar=useNativeMenuBar;', sandbox);
  const state = { authenticated: true, recordTitle: '会议', capture: 'recording', recording: true, busy: false, connection: 'connected' };
  const callbacks = Object.fromEntries(['pause', 'resume', 'finish', 'settings', 'microphone'].map(name => [name, () => actions.push(name)]));
  sandbox.exports.useNativeMenuBar(state, callbacks);
  await new Promise(resolve => setImmediate(resolve));
  return { calls, actions, refs, state, callbacks, timers, event: payload => handler({ payload }), cleanup: () => cleanup(), removed: () => removed };
}

test('native menu reports account-wide queue count and uses current callbacks', async () => {
  const h = await harness();
  assert.equal(h.calls[0].command, 'client_status');
  assert.equal(h.calls[0].input.report.pendingCount, 7);
  h.event('status-pause'); assert.deepEqual(h.actions, ['pause']);
  h.refs[0].current = { state: { ...h.state, capture: 'paused', recording: false }, actions: h.callbacks };
  h.event('status-pause'); h.event('status-resume'); h.event('status-finish');
  assert.deepEqual(h.actions, ['pause', 'resume', 'finish']);
  h.cleanup(); assert.equal(h.removed(), true);
});

test('busy, signed-out and completed meetings cannot trigger recording controls', async () => {
  const h = await harness();
  for (const state of [{ ...h.state, busy: true }, { ...h.state, authenticated: false }, { ...h.state, capture: 'completed', recording: false }]) {
    h.refs[0].current = { state, actions: h.callbacks };
    h.event('status-pause'); h.event('status-resume'); h.event('status-finish'); h.event('unknown'); if (!state.authenticated || state.busy) h.event('status-settings');
  }
  assert.deepEqual(h.actions, []); h.cleanup();
});

test('unmount stops reports from an old renderer lifecycle', async () => {
  const h = await harness(); h.cleanup();
  h.timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); assert.deepEqual(h.actions, []);
});

test('native updater menu listener shares dropdown preferences and rechecks the recording gate', async () => {
  const engineSource = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/client-updates.ts', import.meta.url), 'utf8'));
  const engineModule = await import(`data:text/javascript;base64,${Buffer.from(engineSource).toString('base64')}`);
  const hook = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/useClientUpdates.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '');
  const refs = [], cleanups = [], calls = [], listeners = new Map(), removed = [], saved = [], timers = [];
  const activity = { authenticated: true, recording: false, paused: false, busy: false };
  let status = { phase: 'idle', currentVersion: '1.0.0', downloaded: 0 };
  const sandbox = { ...engineModule, exports: {}, isTauri: () => true,
    useRef: current => { const ref = { current }; refs.push(ref); return ref; },
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: effect => { cleanups.push(effect()); },
    invoke: async (command, input) => { calls.push({ command, input: structuredClone(input) }); if (command === 'update_check' && status.phase !== 'ready') status = { ...status, phase: 'available' }; if (command === 'update_download') status = { ...status, phase: 'ready' }; return status; },
    listen: async (name, listener) => { listeners.set(name, listener); return () => removed.push(name); },
    updateQueueState: async () => ({ pendingBytes: 0, pendingCount: 0, queueBusy: false }),
    localStorage: { getItem: () => JSON.stringify({ autoCheck: false, autoDownload: true, autoInstall: true }), setItem: (_key, value) => saved.push(JSON.parse(value)) },
    window: { setInterval: callback => { timers.push(callback); return timers.length; }, setTimeout: () => 1 }, clearInterval() {}, clearTimeout() {},
    document: { getElementById: () => ({ toggleAttribute() {}, removeAttribute() {} }) }, addEventListener() {}, removeEventListener() {}
  };
  vm.runInNewContext(hook + '\nexports.useClientUpdates=useClientUpdates;', sandbox);
  const updates = sandbox.exports.useClientUpdates(activity);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.settings.autoInstall, false);
  assert.equal(updates.settings.autoDownload, false);
  const event = listeners.get('client-menu-action');
  event({ payload: 'status-update-background' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.at(-1).autoDownload, true); assert.equal(saved.at(-1).autoCheck, true); assert.equal(saved.at(-1).autoInstall, false);
  event({ payload: 'status-update-check' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.command === 'update_check').length, 2);
  assert.equal(calls.filter(call => call.command === 'update_download').length, 1);
  refs[0].current = { ...activity, paused: true };
  event({ payload: 'status-update-install' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call.command === 'update_install'), false);
  refs[0].current = activity;
  event({ payload: 'status-update-install' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.command === 'update_install').length, 1);
  cleanups.forEach(cleanup => cleanup?.()); const count = calls.length;
  timers[0](); event({ payload: 'status-update-check' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, count); assert.deepEqual(removed.sort(), ['client-menu-action', 'client-update-state']);
});

test('widget microphone action uses the current recording guard and shared microphone callback', async () => {
 const h=await harness();h.event('status-microphone');assert.deepEqual(h.actions,['microphone']);
 for(const state of [{...h.state,busy:true},{...h.state,authenticated:false},{...h.state,recording:false,capture:'completed'}]){
  h.refs[0].current={state,actions:h.callbacks};h.event('status-microphone');
 }
 assert.deepEqual(h.actions,['microphone']);h.cleanup();
});

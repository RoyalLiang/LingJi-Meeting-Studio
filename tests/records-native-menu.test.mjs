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
  const callbacks = Object.fromEntries(['pause', 'resume', 'finish', 'settings'].map(name => [name, () => actions.push(name)]));
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

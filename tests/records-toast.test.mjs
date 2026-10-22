import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/components/Toast.tsx', import.meta.url), 'utf8');
const compiled = (await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs' })).code;

test('actionable warnings stay visible until dismissed and expose the requested action',()=>{
  const h=harness();let actions=0,dismissals=0;
  const tree=h.render({message:'转录暂时中断。',warning:true,persistent:true,action:{label:'重新处理',run:()=>{actions++;}},dismiss:()=>{dismissals++;}});
  assert.match(tree.props.className,/is-warning/);assert.equal(tree.props.role,'status');
  const content=tree.props.children.find(node=>node?.props?.className==='toast-content');
  const action=content.props.children.find(node=>node?.props?.className==='toast-action');
  assert.equal(action.props.children,'重新处理');action.props.onClick();assert.equal(actions,1);
  h.tick(60000);assert.equal(dismissals,0,'actionable warning must not disappear during a pending recovery');
  tree.props.children.find(node=>node?.props?.['aria-label']==='关闭提示').props.onClick();assert.equal(dismissals,1);
  h.unmount();
});

function harness() {
  const slots = [], pending = [], timers = new Map(), listeners = new Map(), elementListeners = new Map();
  let cursor = 0, now = 0, nextTimer = 0, open = false, hovered = false;
  const element = {
    isConnected: true,
    matches: selector => selector === ':hover' ? hovered : open,
    contains: target => target === element,
    showPopover: () => { open = true; elementListeners.get('beforetoggle')?.({ newState: 'open' }); },
    hidePopover: () => { open = false; elementListeners.get('beforetoggle')?.({ newState: 'closed' }); },
    addEventListener: (name, callback) => elementListeners.set(name, callback),
    removeEventListener: (name, callback) => { if (elementListeners.get(name) === callback) elementListeners.delete(name); }
  };
  const document = {
    hidden: false, activeElement: null,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); }
  };
  const useRef = initial => slots[cursor++] ||= { current: initial };
  const effect = (callback, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) pending.push(() => {
      previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() };
    });
  };
  const jsx = (type, props, key) => { if (props.ref) props.ref.current = element; return { type, props, key }; };
  const exports = {}, sandbox = {
    exports, module: { exports }, document, performance: { now: () => now },
    HTMLElement: class { showPopover() {} },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => name === 'react' ? { useRef, useEffect: effect, useLayoutEffect: effect } : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : {}
  };
  vm.runInNewContext(compiled, sandbox);
  return {
    duration: sandbox.module.exports.getToastDuration,
    render(props) { cursor = 0; const tree = sandbox.module.exports.Toast(props); pending.splice(0).forEach(run => run()); return tree; },
    tick(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = target;
    },
    hover(tree, value) { hovered = value; tree.props[value ? 'onMouseEnter' : 'onMouseLeave'](); },
    focus(tree, value) { document.activeElement = value ? element : null; tree.props[value ? 'onFocus' : 'onBlur']({ currentTarget: element, relatedTarget: null }); },
    hidden(value) { document.hidden = value; listeners.get('visibilitychange')?.(); },
    covered(value) { element[value ? 'hidePopover' : 'showPopover'](); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    get timers() { return timers.size; }, get listeners() { return listeners.size + elementListeners.size; }, get open() { return open; }
  };
}

function groupHarness() {
  const instances = new Map(), timers = new Map(), documentListeners = new Set();
  let current, cursor = 0, now = 0, nextTimer = 0;
  const instance = id => {
    if (!instances.has(id)) {
      const listeners = new Set(), state = { slots: [], pending: [], open: false };
      state.element = {
        isConnected: true, matches: selector => selector === ':popover-open' && state.open, contains: () => false,
        showPopover() { assert.equal(this.isConnected, true, 'never restore a disconnected toast'); state.open = true; listeners.forEach(fn => fn({ newState: 'open' })); },
        hidePopover() { state.open = false; listeners.forEach(fn => fn({ newState: 'closed' })); },
        addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (name, fn) => listeners.delete(fn)
      };
      instances.set(id, state);
    }
    return instances.get(id);
  };
  const effect = (callback, deps) => {
    const state = current, index = cursor++, previous = state.slots[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) state.pending.push(() => {
      previous?.cleanup?.(); state.slots[index] = { deps, cleanup: callback() };
    });
  };
  const jsx = (type, props) => { if (props.ref) props.ref.current = current.element; return { type, props }; };
  const exports = {}, sandbox = {
    exports, module: { exports }, performance: { now: () => now }, HTMLElement: class { showPopover() {} },
    document: { hidden: false, activeElement: null, addEventListener: (name, fn) => documentListeners.add(fn), removeEventListener: (name, fn) => documentListeners.delete(fn) },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    require: name => name === 'react' ? { useRef: initial => current.slots[cursor++] ||= { current: initial }, useEffect: effect, useLayoutEffect: effect } : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : {}
  };
  vm.runInNewContext(compiled, sandbox);
  return {
    render(id, props) { current = instance(id); cursor = 0; sandbox.module.exports.Toast(props); current.pending.splice(0).forEach(run => run()); },
    unmount(id) { const state = instance(id); state.element.isConnected = false; state.slots.forEach(slot => slot?.cleanup?.()); },
    open(id) { const state = instance(id); return state.element.isConnected && state.open; },
    tick(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = target;
    },
    get timers() { return timers.size; }, get listeners() { return documentListeners.size; }
  };
}

test('ordinary toast closes after five seconds; long messages get bounded reading time', () => {
  const h = harness(); let dismissed = 0;
  const tree = h.render({ message: '会议标题已保存。', dismiss: () => dismissed++ });
  assert.equal(tree.props.role, 'status'); assert.equal(tree.props['aria-live'], 'polite');
  assert.equal(tree.props['aria-atomic'], 'true'); assert.equal(h.open, true);
  assert.equal(tree.props.autoFocus, undefined);
  h.tick(4999); assert.equal(dismissed, 0); h.tick(1); assert.equal(dismissed, 1);
  assert.equal(h.duration('字'.repeat(40)), 5000);
  assert.equal(h.duration('字'.repeat(80)), 8000);
  assert.equal(h.duration('字'.repeat(400)), 10000);
  h.unmount(); assert.equal(h.open, false);
});

test('hover and keyboard focus pause the same remaining time until both end', () => {
  const h = harness(); let dismissed = 0;
  const tree = h.render({ message: '已保存', dismiss: () => dismissed++ });
  h.tick(1000); h.hover(tree, true); h.focus(tree, true);
  h.tick(10000); h.hover(tree, false); h.tick(10000); assert.equal(dismissed, 0);
  h.focus(tree, false); h.tick(3999); assert.equal(dismissed, 0);
  h.tick(1); assert.equal(dismissed, 1);
});

test('hidden pages pause reading time and resume it when shown', () => {
  const h = harness(); let dismissed = 0;
  h.render({ message: '已保存', dismiss: () => dismissed++ });
  h.tick(2000); h.hidden(true); h.tick(20000); assert.equal(dismissed, 0);
  h.hidden(false); h.tick(2999); assert.equal(dismissed, 0); h.tick(1); assert.equal(dismissed, 1);
  const initiallyHidden = harness(); initiallyHidden.hidden(true);
  initiallyHidden.render({ message: '后台完成', dismiss: () => dismissed++ });
  initiallyHidden.tick(20000); assert.equal(dismissed, 1);
  initiallyHidden.hidden(false); initiallyHidden.tick(5000); assert.equal(dismissed, 2);
});

test('repeating the same text with a new key restarts its timer', () => {
  const h = harness(); let dismissed = 0;
  const props = { message: '已保存', messageKey: 1, dismiss: () => dismissed++ };
  h.render(props); h.tick(4000); h.render({ ...props, messageKey: 2 });
  h.tick(4999); assert.equal(dismissed, 0); h.tick(1); assert.equal(dismissed, 1);
});

test('covered toast resumes its remaining reading time when restored', () => {
  const h = harness(); let dismissed = 0;
  h.render({ message: '已保存', dismiss: () => dismissed++ });
  h.tick(1000); h.covered(true); h.tick(20000); assert.equal(dismissed, 0);
  h.covered(false); h.tick(3999); assert.equal(dismissed, 0); h.tick(1); assert.equal(dismissed, 1);
  h.unmount(); assert.equal(h.listeners, 0);
});

test('rerender keeps elapsed time and uses the latest callback; unmount clears timer and listener', () => {
  const h = harness(); let first = 0, latest = 0;
  h.render({ message: '已保存', dismiss: () => first++ }); h.tick(4000);
  h.render({ message: '已保存', dismiss: () => latest++ }); h.tick(1000);
  assert.equal(first, 0); assert.equal(latest, 1);
  h.render({ message: '第二条', dismiss: () => latest++ }); assert.equal(h.timers, 1);
  h.unmount(); assert.equal(h.timers, 0); assert.equal(h.listeners, 0);
  h.tick(10000); assert.equal(latest, 1);
});

test('errors and explicitly persistent messages stay until dismissed', () => {
  for (const flags of [{ error: true }, { persistent: true }]) {
    const h = harness(); let dismissed = 0;
    const tree = h.render({ message: '需要处理的信息', ...flags, dismiss: () => dismissed++ });
    h.tick(60000); assert.equal(dismissed, 0); assert.equal(h.timers, 0);
    const close = tree.props.children.at(-1); close.props.onClick(); assert.equal(dismissed, 1);
    h.unmount();
  }
});

test('a newer success toast restores the mounted persistent error when it closes', () => {
  const h = groupHarness(); let errorDismissed = 0;
  h.render('error', { message: '保存失败，请重试', error: true, dismiss: () => errorDismissed++ });
  h.render('success', { message: '已复制', dismiss: () => h.unmount('success') });
  assert.equal(h.open('error'), false); assert.equal(h.open('success'), true);
  h.tick(5000); assert.equal(h.open('error'), true); assert.equal(h.open('success'), false);
  h.tick(20000); assert.equal(errorDismissed, 0);
  h.unmount('error'); assert.equal(h.timers, 0); assert.equal(h.listeners, 0);
});

test('a covered success resumes its remaining time after the newer toast closes', () => {
  const h = groupHarness(); let firstDismissed = 0;
  h.render('first', { message: '已保存', dismiss: () => { firstDismissed++; h.unmount('first'); } });
  h.tick(1000); h.render('second', { message: '已复制', dismiss: () => h.unmount('second') });
  h.tick(5000); assert.equal(h.open('first'), true); assert.equal(firstDismissed, 0);
  h.tick(3999); assert.equal(firstDismissed, 0); h.tick(1); assert.equal(firstDismissed, 1);
  assert.equal(h.timers, 0); assert.equal(h.listeners, 0);
});

test('unmounting a covered toast removes it from the restoration stack', () => {
  const h = groupHarness(); let firstDismissed = 0;
  h.render('first', { message: '旧页面提示', dismiss: () => firstDismissed++ });
  h.render('second', { message: '已复制', dismiss: () => h.unmount('second') });
  h.unmount('first'); h.tick(5000);
  assert.equal(h.open('first'), false); assert.equal(firstDismissed, 0);
  assert.equal(h.timers, 0); assert.equal(h.listeners, 0);
});

test('retriggering a covered toast with the same message makes it latest and restarts its timer', () => {
  const h = groupHarness(); let firstDismissed = 0, secondDismissed = 0;
  const first = { message: '已保存', messageKey: 1, dismiss: () => { firstDismissed++; h.unmount('first'); } };
  h.render('first', first); h.tick(1000);
  h.render('second', { message: '已复制', dismiss: () => { secondDismissed++; h.unmount('second'); } }); h.tick(500);
  h.render('first', { ...first, messageKey: 2 });
  assert.equal(h.open('first'), true); assert.equal(h.open('second'), false);
  h.tick(4999); assert.equal(firstDismissed, 0); h.tick(1); assert.equal(firstDismissed, 1);
  assert.equal(h.open('second'), true); h.tick(4499); assert.equal(secondDismissed, 0);
  h.tick(1); assert.equal(secondDismissed, 1); assert.equal(h.timers, 0); assert.equal(h.listeners, 0);
});

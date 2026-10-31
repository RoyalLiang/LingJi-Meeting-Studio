import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const compiled = (await transform(`${source}\nexport const authTestComponents = { Auth, Workspace };`, { loader: 'tsx', jsx: 'automatic', format: 'cjs', define: { 'import.meta.env.DEV': 'false' } })).code;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// Execute the real components with deterministic React hooks. Network completion
// is held at each boundary, so repeated submit events run before React rerenders.
function harness(api) {
  const slots = [], effects = []; let cursor = 0;
  const useState = initial => {
    const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const useRef = initial => { const index = cursor++; return slots[index] ||= { current: initial }; };
  const useCallback = callback => { cursor++; return callback; };
  const useEffect = (effect, deps) => {
    const index = cursor++, previous = slots[index]; slots[index] = deps;
    if (!previous || deps.some((value, i) => value !== previous[i])) effects.push(effect);
  };
  const component = () => null;
  const generic = new Proxy({}, { get: () => component });
  const exports = {};
  const sandbox = {
    module: { exports }, exports,
    require: name => name === 'react' ? { useState, useRef, useEffect, useCallback, lazy: () => component } : name === 'react/jsx-runtime' ? {
      jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('fragment')
    } : name === './api' ? { api, ApiError: class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }, setCsrf() {}, setAudioTransport() {}, messageOf: error => error.message } : generic,
    location: { pathname: '/', search: '' }, localStorage: { getItem: () => null }, navigator: { onLine: true },
    URLSearchParams, AbortController, document: { documentElement: { dataset: {} } },
    FormData: class { constructor(form) { this.form = form; } *[Symbol.iterator]() { yield* Object.entries(this.form); } },
  };
  vm.runInNewContext(compiled, sandbox);
  return { render(name, props = {}) { cursor = 0; return sandbox.module.exports.authTestComponents[name](props); }, effects };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return [node.props?.children].flat(Infinity).map(child => find(child, predicate)).find(Boolean);
}
const button = (node, text) => find(node, item => item.props?.children === text);
const form = node => find(node, item => item.type === 'form');

test('rapid login and development-account clicks submit once and stay busy through bootstrap', async () => {
  const login = deferred(), boot = deferred(); let posts = 0, readyCalls = 0;
  const h = harness(path => path === '/development-account' ? Promise.resolve({ email: 'test@example.com', password: 'local-only-test' }) : (posts++, login.promise));
  const props = { ready: () => { readyCalls++; return boot.promise; } };
  h.render('Auth', props); h.effects.shift()(); await tick();
  let page = h.render('Auth', props);
  const submit = () => form(page).props.onSubmit({ preventDefault() {}, currentTarget: { email: 'test@example.com', password: 'local-only-test' } });
  const first = submit(), second = submit(), third = button(page, '使用开发账户进入').props.onClick();
  assert.equal(posts, 1, 'one login request must own all login entry points');
  login.resolve({ csrf: 'test-csrf' }); await tick();
  assert.equal(readyCalls, 1);
  page = h.render('Auth', props);
  assert.equal(button(page, '使用开发账户进入').props.disabled, true);
  assert.equal(button(page, '还没有账户？创建一个').props.disabled, true);
  assert.equal(find(page, item => item.props?.type === 'submit').props.disabled, true, 'login remains busy until workspace bootstrap finishes');
  boot.resolve(true); await Promise.all([first, second, third]);
});

test('failed bootstrap reports the error on the existing login form and permits one retry', async () => {
  let posts = 0, readyCalls = 0;
  const h = harness(() => { posts++; return Promise.resolve({ csrf: 'test-csrf' }); });
  const props = { ready: () => { readyCalls++; return Promise.reject(new Error('会议空间暂时不可用')); } };
  let page = h.render('Auth', props);
  await form(page).props.onSubmit({ preventDefault() {}, currentTarget: {} });
  page = h.render('Auth', props);
  assert.equal(find(page, item => item.props?.role === 'alert')?.props.children, '会议空间暂时不可用');
  assert.equal(find(page, item => item.props?.type === 'submit').props.disabled, false);
  await form(page).props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.equal(posts, 2); assert.equal(readyCalls, 2);
});

test('workspace bootstrap deduplicates requests without replacing login with a loading page', async () => {
  const response = deferred(); let requests = 0;
  const h = harness(path => {
    if (path === '/bootstrap') { requests++; return requests === 1 ? Promise.reject(new Error('not signed in')) : response.promise; }
    if (path === '/records') return Promise.resolve({ records: [] });
    if (path === '/workspaces') return Promise.resolve({ workspaces: [] });
    throw new Error(`unexpected path ${path}`);
  });
  const initial = h.render('Workspace'); assert.equal(initial.props.className, 'loading-page');
  h.effects.find(effect => effect.toString().includes('loadBoot'))(); await tick();
  let page = h.render('Workspace'); const ready = page.props.ready;
  const first = ready(), second = ready();
  assert.equal(requests, 2, 'only one bootstrap request after initial unauthenticated check');
  page = h.render('Workspace');
  assert.equal(typeof page.type, 'function', 'the login form stays mounted during authentication bootstrap');
  assert.ok(page.props.ready);
  response.resolve({ csrf: 'test-csrf', providers: { fixture: true }, email: 'test@example.com' });
  await Promise.all([first, second]);
  page = h.render('Workspace'); assert.equal(page.props.className, 'app-shell');
});

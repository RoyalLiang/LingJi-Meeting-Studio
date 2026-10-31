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
function harness(api, {search='',modules={}} = {}) {
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
    require: name => name === 'react' ? { memo:component=>component, useState, useRef, useEffect, useCallback, lazy: () => component } : name === 'react/jsx-runtime' ? {
      jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('fragment')
    } : name === './useClientUpdates' ? { useClientUpdates: () => ({native:false,status:{phase:'idle',currentVersion:'0.1.47',downloaded:0}}) } : name === './api' ? { api, ApiError: class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }, setCsrf() {}, setAudioTransport() {}, messageOf: error => error.message } : modules[name] || generic,
    location: { pathname: '/', search }, localStorage: { getItem: () => null }, navigator: { onLine: true },
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

test('Pi center keeps the main workspace mounted and returns to its directory through the shared selection path', async () => {
  const h=harness(path=>{
    if(path==='/bootstrap')return Promise.resolve({csrf:'test-csrf',providers:{fixture:true},email:'test@example.com'});
    if(path==='/records')return Promise.resolve({records:[]});
    if(path==='/workspaces')return Promise.resolve({workspaces:[]});
    throw new Error(`unexpected path ${path}`);
  });
  h.render('Workspace');
  h.effects.find(effect=>effect.toString().includes('loadBoot'))();await tick();
  let page=h.render('Workspace');
  const entry=find(page,item=>item.props?.className?.includes('extension-entry'));
  assert.ok(entry,'the real Pi center has an independent workspace entry');
  entry.props.onClick();page=h.render('Workspace');
  assert.equal(page.props.className,'app-shell');
  const center=find(page,item=>Array.isArray(item.props?.records)&&typeof item.props?.openRecord==='function');
  assert.ok(center,'the center receives the same real record list and selection callback');
  assert.equal(find(page,item=>item.props?.className?.includes('directory-home-link')).props.className.includes('selected'),false);
  find(page,item=>item.props?.className?.includes('directory-home-link')).props.onClick();
  page=h.render('Workspace');
  assert.equal(page.props.className,'app-shell');
  assert.equal(find(page,item=>Array.isArray(item.props?.records)&&typeof item.props?.openRecord==='function'),undefined);
  assert.equal(find(page,item=>item.props?.className?.includes('directory-home-link')).props.className.includes('selected'),true);
});

test('native resume returns from Pi center to the same paused meeting without bypassing capture guards', async () => {
  const started=deferred(),controllers=[];let secure=false,nativeMenu,subscription;
  const paused={id:'paused-record',title:'暂停的会议',capture:'paused',transcription:'completed',language:'zh',sources:[],segments:[],notes:'',notesRevision:0,minutes:null,liveMinutes:null,minutesRevision:0,minuteVersions:[],transcriptRevision:0,cursor:'1',jobs:[],pendingChunks:0,retainAudio:true,retentionDays:30,deleteAt:'2026-11-30T00:00:00Z',usage:{samples:0,llmTokens:0}};
  const list=[{id:paused.id,title:paused.title,capture:'paused',hasMinutes:false,createdAt:'2026-10-31T00:00:00Z',seconds:0}];
  class AudioDevice {
    constructor(id){this.recordId=id;this.active=false;controllers.push(this);}
    async startMeeting(){await started.promise;this.active=true;return [];}
    async stop(){this.active=false;}
  }
  const h=harness(path=>{
    if(path==='/bootstrap')return Promise.resolve({csrf:'test-csrf',providers:{asr:true},email:'test@example.com'});
    if(path==='/records')return Promise.resolve({records:list});
    if(path==='/workspaces')return Promise.resolve({workspaces:[]});
    if(path===`/records/${paused.id}`)return Promise.resolve({...paused,capture:controllers.some(controller=>controller.active)?'recording':'paused',cursor:'2'});
    throw new Error(`unexpected path ${path}`);
  },{search:`?record=${paused.id}`,modules:{
    './useNativeMenuBar':{useNativeMenuBar:(state,actions)=>{nativeMenu={state,actions};}},
    './record-subscription':{subscribeToRecord:options=>{subscription=options;return()=>{};}},
    './audio/controller':{CaptureController:AudioDevice,capabilities:()=>({secure,worklet:true})},
  }});
  h.render('Workspace');h.effects.find(effect=>effect.toString().includes('loadBoot'))();await tick();
  h.render('Workspace');
  h.effects.findLast(effect=>effect.toString().includes('recordCache.current.get(id)'))();
  h.effects.findLast(effect=>effect.toString().includes('subscribeToRecord'))();
  subscription.onRecord(paused);
  let page=h.render('Workspace');
  find(page,item=>item.props?.className?.includes('extension-entry')).props.onClick();
  page=h.render('Workspace');assert.equal(page.props.className,'app-shell');assert.ok(find(page,item=>Array.isArray(item.props?.records)&&typeof item.props?.openRecord==='function'));
  nativeMenu.actions.resume();await tick();page=h.render('Workspace');
  assert.equal(controllers.length,0,'unavailable audio capability must still prevent capture');
  assert.ok(find(page,item=>Array.isArray(item.props?.records)&&typeof item.props?.openRecord==='function'),'a refused capture does not change the current view');
  secure=true;nativeMenu.actions.resume();
  assert.equal(controllers.length,1);assert.equal(controllers[0].recordId,paused.id,'resume reuses the selected meeting instead of creating one');
  started.resolve();await tick();page=h.render('Workspace');
  assert.equal(nativeMenu.state.recording,true,'the real Workspace resume path has started capture');
  assert.equal(page.props.className,'app-shell','resuming must reveal the meeting controls');
  assert.ok(find(page,item=>item.props?.className==='meeting-header glass'));
  assert.equal(find(page,item=>Array.isArray(item.props?.records)&&typeof item.props?.openRecord==='function'),undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeThemeSync} from '../apps/web/src/native-theme.ts';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

test('preloaded recording windows follow stored theme changes and resets',async()=>{
  const source=stripTypeScriptTypes(await readFile(new URL('../apps/web/src/native-theme.ts',import.meta.url),'utf8')).replace(/^export /gm,'');
  const window=new EventTarget(),document=new EventTarget();document.documentElement={dataset:{}};
  const localStorage={getItem:()=> 'light'};let changes=0;document.addEventListener('meeting:theme',()=>changes++);
  vm.runInNewContext(source+'\ninitializeTheme();',{window,document,localStorage,Event});
  assert.equal(document.documentElement.dataset.theme,'light');
  const stored=(key,newValue)=>window.dispatchEvent(Object.assign(new Event('storage'),{key,newValue,storageArea:localStorage}));
  stored('meeting-theme','dark');assert.equal(document.documentElement.dataset.theme,'dark');
  stored('other-setting','light');assert.equal(document.documentElement.dataset.theme,'dark');
  stored('meeting-theme','light');assert.equal(document.documentElement.dataset.theme,'light');
  stored('meeting-theme','dark');stored(null,null);assert.equal(document.documentElement.dataset.theme,'light');
  assert.equal(changes,5);
  const fallback=new EventTarget();fallback.documentElement={dataset:{theme:'dark'}};
  vm.runInNewContext(source+'\ninitializeTheme();',{window:new EventTarget(),document:fallback,localStorage:{getItem(){throw Error('storage unavailable');}},Event});
  assert.equal(fallback.documentElement.dataset.theme,'light');
});
test('mobile theme follows system changes until the user chooses an appearance', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../apps/web/src/native-theme.ts', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const system = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), { documentElement: { dataset: {} } });
  let preference = null;
  vm.runInNewContext(source + '\ninitializeTheme(system);', {
    system, window: new EventTarget(), document, localStorage: { getItem: () => preference }, Event,
  });
  assert.equal(document.documentElement.dataset.theme, 'light');
  system.matches = true;
  system.dispatchEvent(new Event('change'));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  preference = 'dark';
  system.matches = false;
  system.dispatchEvent(new Event('change'));
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('theme changes coalesce and the latest choice follows an in-flight native update',async()=>{
 const calls=[];let release;const sync=nativeThemeSync(async theme=>{calls.push(theme);if(calls.length===1)await new Promise(resolve=>release=resolve);});
 const first=sync.set('light');await new Promise(resolve=>setImmediate(resolve));
 sync.set('dark');sync.set('light');const final=sync.set('dark');
 assert.deepEqual(calls,['light']);release();await first;await final;assert.deepEqual(calls,['light','dark']);
 await sync.set('dark');assert.equal(calls.length,2);
});
test('a failed update can be retried and stopping discards queued appearances',async()=>{
 let count=0;const sync=nativeThemeSync(async()=>{if(++count===1)throw Error('window unavailable');});
 await assert.rejects(sync.set('dark'));await sync.set('dark');assert.equal(count,2);
 const pending=sync.set('light');sync.stop();await pending;assert.equal(count,2);
});

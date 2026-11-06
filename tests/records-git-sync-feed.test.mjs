import {createSettingsCache} from '../apps/web/src/settings-cache.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transpileTypeScript} from './helpers/typescript.mjs';

test('Git status discards an earlier account response without clearing the new account request or cache',async()=>{
  const requests=[],exports={};
  const source=(await Promise.all(['api.ts','git-sync-feed.ts'].map(async file=>transpileTypeScript(await readFile(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8')).replace(/^import .*$/gm,'').replace(/export /g,'')))).join('\n');
  vm.runInNewContext(source+'\nObject.assign(exports,{setCsrf,gitSyncStatus});',{createSettingsCache,
    exports,AbortSignal,DOMException,Date,performance,trace(){},
    fetch:()=>new Promise(resolve=>requests.push(value=>resolve({ok:true,json:async()=>value})))
  });
  const alice={enabled:true,recent:[{id:'alice-task',title:'Private Alice meeting',preview:'Private Alice summary'}]};
  const bob={enabled:true,recent:[{id:'bob-task',title:'Bob meeting'}]};
  exports.setCsrf('alice-session');
  const previous=exports.gitSyncStatus();
  assert.equal(exports.gitSyncStatus(),previous);
  const discarded=assert.rejects(previous,{name:'AbortError'});
  exports.setCsrf('');
  exports.setCsrf('bob-session');
  const current=exports.gitSyncStatus();
  assert.equal(requests.length,2);
  requests[0](alice);await discarded;
  assert.equal(exports.gitSyncStatus(),current,'old completion must not clear Bob’s pending request');
  requests[1](bob);assert.equal(await current,bob);
  assert.equal(await exports.gitSyncStatus(),bob);
  assert.equal(requests.length,2,'same-account results remain cached');
  exports.setCsrf('');
  const loggedOut=exports.gitSyncStatus();
  assert.equal(requests.length,3,'logout must invalidate the previous account’s cached result');
  const empty={enabled:false,recent:[]};requests[2](empty);assert.equal(await loggedOut,empty);
});


test('a confirmed mutation discards stale pending status without replacing the fresh request',async()=>{
 const requests=[],exports={};const source=(await Promise.all(['api.ts','git-sync-feed.ts'].map(async file=>transpileTypeScript(await readFile(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8')).replace(/^import .*$/gm,'').replace(/export /g,'')))).join('\n');
 vm.runInNewContext(source+'\nObject.assign(exports,{gitSyncStatus,invalidateGitSyncStatus});',{createSettingsCache,exports,AbortSignal,DOMException,Date,performance,trace(){},fetch:()=>new Promise(resolve=>requests.push(value=>resolve({ok:true,json:async()=>value})))});
 const old=exports.gitSyncStatus(),discarded=assert.rejects(old,{name:'AbortError'});exports.invalidateGitSyncStatus();const fresh=exports.gitSyncStatus();assert.equal(requests.length,2);requests[0]({enabled:true,recent:[{status:'waiting'}]});await discarded;assert.equal(exports.gitSyncStatus(),fresh);const value={enabled:true,recent:[{status:'running'}]};requests[1](value);assert.equal(await fresh,value);assert.equal(await exports.gitSyncStatus(),value);
});

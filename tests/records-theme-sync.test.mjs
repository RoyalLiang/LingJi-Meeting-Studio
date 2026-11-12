import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeThemeSync} from '../apps/web/src/native-theme.ts';
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

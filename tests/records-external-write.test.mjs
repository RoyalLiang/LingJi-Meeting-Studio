import test from 'node:test';
import assert from 'node:assert/strict';
import {externalWrite} from '../services/records/src/external-write.mjs';
test('uncertain write reconciles before replay and preserves receipt',async()=>{
 const row={writes:{}};let remote,attempts=0;
 const options={key:'archive',fingerprint:'fixed',load:async()=>row,save:async(key,state)=>{row.writes[key]=structuredClone(state);},guard:async()=>{},reconcile:async()=>remote?{status:'confirmed',receipt:remote}:{status:'absent'},execute:async()=>{attempts++;remote={id:'committed'};throw new Error('connection lost after write');}};
 await assert.rejects(externalWrite(options));assert.equal(row.writes.archive.status,'attempting');
 assert.deepEqual(await externalWrite(options),{id:'committed'});assert.equal(attempts,1);
 assert.deepEqual(await externalWrite(options),{id:'committed'});assert.equal(attempts,1);
 await assert.rejects(externalWrite({...options,fingerprint:'changed'}),{code:'external_write_conflict'});
});
test('non-reconcilable create stays unknown and revoked authorization prevents all remote calls',async()=>{
 const row={writes:{create:{fingerprint:'fixed',status:'attempting',attemptedAt:'earlier'}}};let calls=0;
 const options={key:'create',fingerprint:'fixed',load:async()=>row,save:async()=>{},guard:async()=>{},reconcile:async()=>({status:'unknown'}),execute:async()=>{calls++;}};
 await assert.rejects(externalWrite(options),{code:'external_write_unknown'});assert.equal(calls,0);
 await assert.rejects(externalWrite({...options,guard:async()=>{throw Object.assign(new Error('revoked'),{code:'revoked'});},reconcile:async()=>{calls++;}}),{code:'revoked'});assert.equal(calls,0);
});

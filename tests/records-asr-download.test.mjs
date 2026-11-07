import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {downloadPinned} from '../scripts/prepare-local-asr.mjs';
const bytes=Buffer.from('pinned public audio'),hash=createHash('sha256').update(bytes).digest('hex');
async function temporary(t){const directory=await mkdtemp(join(tmpdir(),'lingji-download-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
test('pinned downloads recover from a transient connection failure',async t=>{
 const directory=await temporary(t),file=join(directory,'fixture');let calls=0;
 await downloadPinned('https://example.test/audio',file,'sha256',hash,'hex',async()=>{if(++calls===1)throw new TypeError('temporary connection timeout');return new Response(bytes);});
 assert.equal(calls,2);assert.deepEqual(await readFile(file),bytes);assert.deepEqual(await readdir(directory),['fixture']);
});
test('verified cached public assets require no network',async t=>{
 const directory=await temporary(t),file=join(directory,'fixture');await writeFile(file,bytes);
 await downloadPinned('https://example.test/audio',file,'sha256',hash,'hex',()=>{throw new Error('network must not be used');});
 assert.deepEqual(await readFile(file),bytes);
});
test('corrupt cache is replaced only by a correctly hashed download',async t=>{
 const directory=await temporary(t),file=join(directory,'fixture');await writeFile(file,'corrupted');
 await downloadPinned('https://example.test/audio',file,'sha256',hash,'hex',async()=>new Response(bytes));assert.deepEqual(await readFile(file),bytes);
});
test('digest mismatches never become cached assets or trigger blind retries',async t=>{
 const directory=await temporary(t);let calls=0;
 await assert.rejects(downloadPinned('https://example.test/audio',join(directory,'fixture'),'sha256',hash,'hex',async()=>{calls++;return new Response('wrong');}),/digest mismatch/);
 assert.equal(calls,1);assert.deepEqual(await readdir(directory),[]);
});
test('persistent connection failures are bounded and leave no partial files',async t=>{
 const directory=await temporary(t);let calls=0;
 await assert.rejects(downloadPinned('https://example.test/audio',join(directory,'fixture'),'sha256',hash,'hex',async()=>{calls++;throw new TypeError('offline');}),/offline/);
 assert.equal(calls,3);assert.deepEqual(await readdir(directory),[]);
});
test('permanent HTTP errors do not trigger download retries',async t=>{
 const directory=await temporary(t);let calls=0;
 await assert.rejects(downloadPinned('https://example.test/audio',join(directory,'fixture'),'sha256',hash,'hex',async()=>{calls++;return new Response('',{status:404});}),/404/);
 assert.equal(calls,1);assert.deepEqual(await readdir(directory),[]);
});

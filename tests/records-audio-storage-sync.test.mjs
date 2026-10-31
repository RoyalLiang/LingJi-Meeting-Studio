import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {flushAudioObject} from '../services/records/src/audio-storage-sync.mjs';

test('Windows audio flush opens the committed object without truncating bytes and propagates failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-object-flush-')),file=join(root,'object');
 try{
  const bytes=Buffer.from([0,1,2,255]);await writeFile(file,bytes);
  await flushAudioObject(file,join(root,'unused-directory'),'win32');
  assert.deepEqual(await readFile(file),bytes);
  await assert.rejects(flushAudioObject(join(root,'missing'),root,'win32'),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('POSIX directory flush remains active before the audio object is acknowledged',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-directory-flush-'));
 try{await flushAudioObject(join(root,'unused-file'),root,process.platform);await assert.rejects(flushAudioObject(join(root,'unused-file'),join(root,'missing'),process.platform),{code:'ENOENT'});}
 finally{await rm(root,{recursive:true,force:true});}
});

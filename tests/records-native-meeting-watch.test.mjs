import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('CoreAudio sampler propagates unknown metadata and releases owned strings', {skip:process.platform!=='darwin'},async()=>{
 const source=await readFile(new URL('../apps/desktop/src-tauri/src/meeting_watch.rs',import.meta.url),'utf8');
 const start=source.indexOf('fn selected('),end=source.indexOf('#[cfg(test)]');assert.ok(start>0 && end>start);
 const actual=source.slice(start,end),abi=await readFile(new URL('./fixtures/meeting-watch-abi.rs',import.meta.url),'utf8');
 const root=await mkdtemp(join(tmpdir(),'meeting-watch-abi-'));
 try{
  const file=join(root,'probe.rs'),binary=join(root,'probe');await writeFile(file,actual+'\n'+abi);
  const compile=spawnSync('rustc',['--edition=2021',file,'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(compile.status,0,compile.error?.message || compile.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.error?.message || run.stderr);
 }finally{await rm(root,{recursive:true,force:true});}
});

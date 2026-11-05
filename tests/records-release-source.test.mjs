import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {snapshotReleaseSource,releaseHash} from '../scripts/release-source.mjs';

test('fixed release source ignores dirty changes and retains installer/build sources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-source-'));
 try{
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']}).toString().trim();git('init');
  for(const [path,value] of Object.entries({'package.json':'{}','apps/web/src/main.ts':'old code','apps/desktop/src-tauri/installer/background.bmp':'bitmap','scripts/release-windows-preview.mjs':'build code','docs/releases/test.md':'instructions','apps/web/.env':'not-a-real-secret','apps/web/.DS_Store':'metadata','.idea/editor.xml':'editor'})){
   await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),value);
  }
  git('add','--force','.');git('-c','user.name=Fixture','-c','user.email=fixture@local.test','commit','-m','fixture');const ref=git('rev-parse','HEAD');
  await writeFile(join(root,'apps/web/src/main.ts'),'dirty code');await writeFile(join(root,'scripts/uncommitted.mjs'),'uncommitted');
  const source=await snapshotReleaseSource({root,ref,destination:join(root,'frozen')});
  assert.equal(await readFile(join(root,'frozen/apps/web/src/main.ts'),'utf8'),'old code');
  assert.ok(source.files.some(f=>f.path==='apps/desktop/src-tauri/installer/background.bmp'));
  assert.ok(source.files.some(f=>f.path==='scripts/release-windows-preview.mjs'));
  assert.ok(source.files.some(f=>f.path==='docs/releases/test.md'));
  assert.ok(source.files.every(f=>!f.path.includes('.env')&&!f.path.includes('.DS_Store')&&!f.path.includes('.idea')&&!f.path.includes('uncommitted')));
  assert.equal(source.sha256,releaseHash(JSON.stringify(source.files)));
  assert.deepEqual(await snapshotReleaseSource({root,ref}),source);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('frozen builds carry verified private vocabulary separately from Git source inventory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lingji-private-source-'));
 const manifestPath='services/records/src/data/builtin-vocabulary.manifest.json',privatePath='services/records/src/data/builtin-vocabulary.private.json';
 try{
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']}).toString().trim();git('init');
  const bytes=Buffer.from(JSON.stringify({schemaVersion:1,version:'fixture.1',entries:[{text:'星河词条',kind:'term'}]}));
  const manifest={schemaVersion:1,version:'fixture.1',entries:1,bytes:bytes.length,sha256:releaseHash(bytes)};
  await mkdir(join(root,'services/records/src/data'),{recursive:true});
  await writeFile(join(root,manifestPath),JSON.stringify(manifest));await writeFile(join(root,privatePath),bytes);
  await writeFile(join(root,'.gitignore'),privatePath+'\n');
  git('add','--','.gitignore',manifestPath);git('-c','user.name=Fixture','-c','user.email=fixture@local.test','commit','-m','fixture');const ref=git('rev-parse','HEAD');
  assert.equal(git('ls-files','--',privatePath),'');
  // A fixed ref owns the expected digest, even if the worktree manifest changes.
  await writeFile(join(root,manifestPath),JSON.stringify({...manifest,sha256:'0'.repeat(64)}));
  const frozen=join(root,'frozen'),source=await snapshotReleaseSource({root,ref,destination:frozen});
  assert.deepEqual(await readFile(join(frozen,privatePath)),bytes);
  assert.ok(source.files.some(file=>file.path===manifestPath));
  assert.ok(!source.files.some(file=>file.path===privatePath));
  assert.deepEqual(await snapshotReleaseSource({root,ref}),source);
  await writeFile(join(root,privatePath),'{}');await assert.rejects(snapshotReleaseSource({root,ref}),/digest/);
  await rm(join(root,privatePath));await assert.rejects(snapshotReleaseSource({root,ref}),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});

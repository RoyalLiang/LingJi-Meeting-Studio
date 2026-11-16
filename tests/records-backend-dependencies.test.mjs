import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {bundleBackendDependencies} from '../scripts/prepare-client-backend.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'lingji-dependencies-')),backend=join(root,'bundle'),source=join(root,'source');
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(source);await mkdir(backend);
  const packages={'':{dependencies:{owner:'1.0.0',shared:'2.0.0'}},'node_modules/owner':{version:'1.0.0'},'node_modules/shared':{version:'2.0.0'},'node_modules/owner/node_modules/shared':{version:'1.0.0'}};
  await writeFile(join(source,'package.json'),JSON.stringify({type:'module'}));await writeFile(join(source,'package-lock.json'),JSON.stringify({packages}));
  for(const [path,name,version,dependencies,code] of [
    ['node_modules/owner','owner','1.0.0',{shared:'1.0.0'},"import {version} from 'shared';export default version;"],
    ['node_modules/shared','shared','2.0.0',{},"export const version='2.0.0';"],
    ['node_modules/owner/node_modules/shared','shared','1.0.0',{},"export const version='1.0.0';"]
  ]){const directory=join(source,path);await mkdir(directory,{recursive:true});await writeFile(join(directory,'package.json'),JSON.stringify({name,version,dependencies,type:'module',exports:'./index.mjs'}));await writeFile(join(directory,'index.mjs'),code);}
  return {source,backend};
}

test('isolated backend retains nested dependency versions instead of flattening them',async t=>{
  const {source,backend}=await fixture(t),modules=await bundleBackendDependencies(source,backend);
  assert.equal(modules.get('shared'),'2.0.0');assert.equal(modules.get('node_modules/owner/node_modules/shared'),'1.0.0');
  const output=execFileSync(process.execPath,['--input-type=module','-e',"import nested from 'owner';import {version} from 'shared';console.log(JSON.stringify([nested,version]));"],{cwd:backend,encoding:'utf8'});
  assert.deepEqual(JSON.parse(output),['1.0.0','2.0.0']);
});

test('a missing locked nested dependency fails rather than silently using a different hoisted version',async t=>{
  const {source,backend}=await fixture(t);await rm(join(source,'node_modules/owner/node_modules/shared'),{recursive:true});
  await assert.rejects(bundleBackendDependencies(source,backend),{code:'ENOENT'});
});


test('an unlocked nested package cannot shadow the locked dependency in the bundle',async t=>{
  const {source,backend}=await fixture(t),lockFile=join(source,'package-lock.json'),lock=JSON.parse(await readFile(lockFile));
  delete lock.packages['node_modules/owner/node_modules/shared'];await writeFile(lockFile,JSON.stringify(lock));
  const ownerFile=join(source,'node_modules/owner/package.json'),owner=JSON.parse(await readFile(ownerFile));owner.dependencies.shared='2.0.0';await writeFile(ownerFile,JSON.stringify(owner));
  await bundleBackendDependencies(source,backend);
  const output=execFileSync(process.execPath,['--input-type=module','-e',"import version from 'owner';console.log(version);"],{cwd:backend,encoding:'utf8'});
  assert.equal(output.trim(),'2.0.0');
});

import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {access,copyFile,mkdir,mkdtemp,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readReleaseSource,snapshotReleaseSource,releaseHash} from './release-source.mjs';
import {assertCurrentSource,finishCurrentBuild} from './wgs-build-contract.mjs';
const currentBuild=process.env.TTS_WGS_CURRENT_BUILD==='1';

assert.equal(process.platform,'linux','DEB packaging requires Linux');
assert.equal(process.arch,'x64','This preview targets Linux x64');
assert.equal(process.env.GITHUB_ACTIONS,'true','Package installation requires disposable GitHub-hosted CI');
if(currentBuild){assert.equal(process.env.RUNNER_ENVIRONMENT,'self-hosted');await access('/.dockerenv');}
else assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Never replace developer installation during verification');
assert.match(await readFile('/etc/os-release','utf8'),/^VERSION_ID="22\.04"$/m,'Build on the oldest supported Ubuntu to preserve its ABI');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const capture=(command,args)=>execFileSync(command,args,{cwd:root,maxBuffer:8*1024*1024}).toString().trim();
const sourceRevision=capture('git',['rev-parse','--verify',`${process.env.TTS_RELEASE_SOURCE_REF||'HEAD'}^{commit}`]);
const config=JSON.parse(await readReleaseSource(root,sourceRevision,'apps/desktop/src-tauri/tauri.preview.conf.json'));
assert.match(config.version,/^\d+\.\d+\.\d+$/);
const output=join(root,'dist/releases',config.version,'linux-x64');
await mkdir(dirname(output),{recursive:true});
await assert.rejects(access(output),{code:'ENOENT'},'A release directory cannot be overwritten');
const scratch=await mkdtemp(join(tmpdir(),'lingji-linux-build-'));
const stage=await mkdtemp(join(dirname(output),'.linux-build-'));
async function run(command,args,cwd=root,env={}){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} failed (${code})`)));
  });
}
let installed,cargoInput;
try{
  const frozen=currentBuild?root:join(scratch,'source');
  cargoInput=currentBuild?await readFile(join(root,'apps/desktop/src-tauri/Cargo.toml'),'utf8'):null;
  const source=currentBuild?await assertCurrentSource(root,sourceRevision):await snapshotReleaseSource({root,ref:sourceRevision,destination:frozen});
  const fixtureCache=join(root,'.agent-runtime/runtimes/asr-fixtures');
  const {prepareAsrFixtures}=await import(pathToFileURL(join(frozen,'scripts/asr-test-fixtures.mjs')).href);
  await prepareAsrFixtures(fixtureCache);
  if(!currentBuild){
 await symlink(join(root,'node_modules'),join(frozen,'node_modules'));
  for(const workspace of ['apps/web','apps/desktop']){
    const modules=join(root,workspace,'node_modules');
    try{await access(modules);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    await symlink(modules,join(frozen,workspace,'node_modules'));
  }
  }
 await run('npm',['run','build:web'],frozen);
  const cargoTarget=process.env.CARGO_TARGET_DIR||join(root,'apps/desktop/src-tauri/target');
  if(currentBuild)await rm(join(cargoTarget,'release/bundle/deb'),{recursive:true,force:true});
  await run('npm',['run','build:native','--workspace','@tts/desktop','--','--config','src-tauri/tauri.preview.conf.json','--config','src-tauri/tauri.linux.conf.json','--bundles','deb'],frozen,{CARGO_TARGET_DIR:cargoTarget});
  const bundle=join(cargoTarget,'release/bundle/deb');
  const installers=(await readdir(bundle)).filter(name=>name.endsWith('.deb'));assert.equal(installers.length,1);
  const artifact=`Lingji-${config.version}-linux-amd64.deb`,path=join(stage,artifact);
  await copyFile(join(bundle,installers[0]),path);
  const packageName=capture('dpkg-deb',['-f',path,'Package']);assert.match(packageName,/^[a-z0-9][a-z0-9+.-]+$/);
  assert.equal(capture('dpkg-deb',['-f',path,'Version']),config.version);
  assert.equal(capture('dpkg-deb',['-f',path,'Architecture']),'amd64');
 const dependencies=capture('dpkg-deb',['-f',path,'Depends']);
 assert.ok(dependencies.split(',').some(group=>group.split('|').some(dep=>/^libasound2(?:\s|$)/.test(dep.trim()))),'Package must resolve ALSA on Ubuntu 22.04');
 assert.ok(!dependencies.split(',').some(group=>/^\s*libasound2t64\b/.test(group)&&!group.includes('|')),'A t64-only dependency excludes Ubuntu 22.04');
  // Installation and removal are confined to the disposable runner, never meeting data.
  installed=packageName;
  await run('sudo',['apt-get','install','-y',path]);
  const files=capture('dpkg-query',['-L',packageName]).split('\n');
  const binary=files.find(file=>file==='/usr/bin/tts-client');assert.ok(binary);
  const node=files.find(file=>file.endsWith('/runtime/node'));assert.ok(node);
  const resources=dirname(dirname(node));
  const backend=join(resources,'client-backend');
  const prepared=join(frozen,'apps/desktop/src-tauri/resources');
  for(const directory of ['runtime','client-backend']){
    for(const relative of await readdir(join(prepared,directory),{recursive:true,withFileTypes:true})){
      if(!relative.isFile())continue;
      const original=join(relative.parentPath,relative.name);
      const suffix=original.slice(prepared.length+1);
      assert.equal(releaseHash(await readFile(join(resources,suffix))),releaseHash(await readFile(original)),`Installed resource differs: ${suffix}`);
    }
  }
  assert.match(capture('file',[binary]),/ELF 64-bit.*x86-64/);
 const glibc=[...capture('objdump',['-T',binary]).matchAll(/GLIBC_(\d+)\.(\d+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
 assert.ok(glibc.length>0&&glibc.every(([major,minor])=>major<2||major===2&&minor<=35),'Binary requires a newer glibc than Ubuntu 22.04');
 const glibcMaximum=glibc.sort((a,b)=>b[0]-a[0]||b[1]-a[1])[0].join('.');
  assert.ok(files.some(file=>file.endsWith('.desktop')));
  await run('xvfb-run',['-a',process.execPath,'scripts/test-standalone-package.mjs',join(stage,'package-smoke-linux-x64.json')],frozen,{NATIVE_CLIENT_EXECUTABLE:binary,TTS_VERIFY_BUNDLED_ASR:'1'});
  await run(node,['scripts/test-bundled-asr.mjs',backend,join(stage,'bundled-asr-linux-x64.json')],frozen,{TTS_ASR_FIXTURE_CACHE:fixtureCache});
  const bundledAsr=JSON.parse(await readFile(join(stage,'bundled-asr-linux-x64.json')));assert.equal(bundledAsr.nativeInference,true);
  await run('sudo',['apt-get','remove','-y',packageName]);installed=null;
  await assert.rejects(access(binary),{code:'ENOENT'},'Uninstall left the executable installed');
  if(currentBuild)await finishCurrentBuild(root,sourceRevision,cargoInput);
 const metadata={sourceBuildMode:currentBuild?'guarded-current-directory':'frozen-copy',builder:currentBuild?'wgs':'github-actions',sourceVerifiedAfterBuild:true,version:config.version,channel:'preview',platform:'linux',architecture:'x64',baselineUbuntu:'22.04',dependencies,glibcMaximum,artifact,sourceRevision,sourceDirty:false,frozenSourceBuild:!currentBuild,signing:'unsigned',sha256:releaseHash(await readFile(path)),source,bundledAsr,
    validation:{debVerified:true,installedAppProbe:true,resourcesVerified:true,uninstallVerified:true,productionSmoke:true,bundledAsrTested:true,realAudioDevicesTested:false,realProvidersTested:false,freshMachineTested:false}};
  await writeFile(join(stage,'release-linux-x64.json'),JSON.stringify(metadata,null,2)+'\n');
  await writeFile(join(stage,'SHA256SUMS-linux-x64.txt'),`${metadata.sha256}  ${artifact}\n`);
  await rename(stage,output);
  console.log(JSON.stringify({output,artifact,sourceRevision,sha256:metadata.sha256}));
}finally{
  if(currentBuild&&cargoInput)await finishCurrentBuild(root,sourceRevision,cargoInput);
  try{if(installed)await run('sudo',['apt-get','remove','-y',installed]);}
  finally{await rm(stage,{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});}
}

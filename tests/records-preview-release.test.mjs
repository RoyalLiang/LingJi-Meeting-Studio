import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPreview, publishPreview, verifyInventory, assertReleaseEvent, previewNotes } from '../scripts/publish-preview-release.mjs';

test('a follow-up preview publishes its version and the changes from its own installer guide', async t => {
  const {options,metadata}=await fixture(t);
  options.tag='v0.1.1';
  const oldArtifact=metadata.artifact;
  metadata.version='0.1.1';metadata.artifact='Lingji-0.1.1-macos-arm64.dmg';
  await rename(join(options.directory,oldArtifact),join(options.directory,metadata.artifact));
  await writeFile(join(options.directory,'release.json'),JSON.stringify(metadata));
  await writeFile(join(options.directory,'SHA256SUMS.txt'),metadata.sha256+'  '+metadata.artifact+'\n');
  const changes='- 修复会议收尾等待后台上传\n- 优化处理提示\n- 新会议按创建时间靠前\n- 减少启动重复写入';
  await writeFile(join(options.directory,'INSTALL-macos-arm64.md'),'# 0.1.1\n\n## 本版变化\n'+changes+'\n\n## 安装\nDo not include the rest as changes.');
  const server=remote(options);
  const result=await publishPreview({...options,api:server.api});
  assert.equal(result.published,true);
  assert.match(server.release.name,/v0\.1\.1.*Public Preview/);
  assert.doesNotMatch(server.release.name,/首次|First Public/);
  assert.ok(server.release.body.includes(changes));
  assert.match(server.release.body,/Lingji-0\.1\.1-macos-arm64\.dmg/);
  assert.doesNotMatch(server.release.body,/Do not include the rest|v0\.1\.0/);
  assert.match((await readFile(join(options.directory,'INSTALL-macos-arm64.md'),'utf8')),/0\.1\.1/);
});

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'preview-publish-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const options={directory,tag:'v0.1.0',commit:'a'.repeat(40),workflowSha:'b'.repeat(40),repository:'owner/repo',runId:'123'};
  const artifact='Lingji-0.1.0-macos-arm64.dmg',bytes=Buffer.from('synthetic installer, not a real DMG');
  const metadata={version:'0.1.0',channel:'preview',platform:'macos',architecture:'arm64',artifact,sourceRevision:options.commit,sourceDirty:false,
    signing:'ad-hoc',notarized:false,frozenSourceBuild:true,sha256:createHash('sha256').update(bytes).digest('hex'),
    validation:{imageVerified:true,copiedAppSignatureVerified:true,productionSmoke:true,realAudioDevicesTested:false,realProvidersTested:false,freshMachineTested:false},
    ci:{repository:options.repository,runId:options.runId,runUrl:'https://github.com/owner/repo/actions/runs/123',workflowSha:options.workflowSha,sourceRevision:options.commit}};
  const smoke={packagedApp:true,independentBackend:true,restartPersistence:true,stableWebviewProfile:true,parentOwnsBackend:true,localAccount:true,devAccountDisabled:true,
    developerBackendRequests:0,realAudioDevicesOpened:false,realProvidersInvoked:false};
  for(const [name,data] of [[artifact,bytes],['SHA256SUMS.txt',metadata.sha256+'  '+artifact+'\n'],['release.json',JSON.stringify(metadata)],['INSTALL-macos-arm64.md','# Preview\n\n## 本版变化\n- Synthetic changes\n'],['package-smoke.json',JSON.stringify(smoke)]])await writeFile(join(directory,name),data);
  return {options,metadata};
}
function remote(options,initial,hook) {
  let release=initial?structuredClone(initial):null;const writes=[];
  const api=async(method,path,data,upload)=>{
    const override=await hook?.({method,path,data,release});if(override)return override;
    if(method==='GET' && path.includes('/git/ref/'))return {object:{type:'tag',sha:'c'.repeat(40)}};
    if(method==='GET' && path.includes('/git/tags/'))return {object:{type:'commit',sha:options.commit}};
    if(method==='GET' && path.includes('/releases?'))return release?[structuredClone(release)]:[];
    if(method==='GET')return structuredClone(release);
    writes.push({method,path,data,upload});
    if(upload){release.assets.push({name:new URL('https://example.test'+path).searchParams.get('name'),size:data.length,state:'uploaded',digest:'sha256:'+createHash('sha256').update(data).digest('hex')});return structuredClone(release.assets.at(-1));}
    release={id:1,assets:[],html_url:'https://github.com/owner/repo/releases/tag/v0.1.0',...release,...data};return structuredClone(release);
  };
  return {api,writes,get release(){return structuredClone(release);}};
}
test('preview publication verifies bytes, provenance and exact file set before mutation',async t=>{
  const {options,metadata}=await fixture(t);assert.equal((await loadPreview(options.directory,options)).files.length,1);
  await writeFile(join(options.directory,metadata.artifact),'changed');
  const server=remote(options);await assert.rejects(publishPreview({...options,api:server.api}));assert.equal(server.writes.length,0);
});
test('preview publication uploads verified installer and update manifest before publishing',async t=>{
  const {options}=await fixture(t),server=remote(options);const result=await publishPreview({...options,api:server.api});
  assert.equal(result.published,true);assert.equal(result.assets.length,2);assert.equal(server.release.prerelease,true);
  assert.equal(server.writes.filter(w=>w.upload).length,2);assert.equal(server.writes.at(-1).data.draft,false);
  const upload=server.writes.find(w=>w.upload && w.path.includes('preview-update.json'));
  const manifest=JSON.parse(upload.data);
  assert.equal(manifest.tag_name,options.tag);assert.equal(manifest.sourceRevision,options.commit);assert.equal(manifest.draft,false);
  const installer=server.release.assets.find(asset=>asset.name!== 'preview-update.json');
  assert.equal(manifest.assets[0].digest,installer.digest);assert.equal(manifest.assets[0].size,installer.size);
  assert.equal(manifest.assets[0].browser_download_url,`https://github.com/${options.repository}/releases/download/${options.tag}/${installer.name}`);
  const after=server.writes.length;await assert.rejects(publishPreview({...options,api:server.api}),/Published release/);assert.equal(server.writes.length,after);
});
test('preview publication adopts matching saved draft and resumes identical partial upload',async t=>{
  const {options}=await fixture(t);const loaded=await loadPreview(options.directory,options),file=loaded.files[0];
  const draft={id:8,tag_name:'untagged-abcd',name:'聆记 v0.1.0 · 首次公开测试版 / First Public Preview',body:'Frozen '+options.commit,draft:true,
    assets:[{name:file.name,size:file.size,digest:file.digest,state:'uploaded'}]};
  const server=remote(options,draft);await publishPreview({...options,api:server.api});
  assert.equal(server.writes[0].method,'PATCH');assert.equal(server.writes[0].path,'/repos/owner/repo/releases/8');
  assert.equal(server.writes.filter(w=>w.upload).length,1);assert.match(server.writes.find(w=>w.upload).path,/preview-update.json/);assert.equal(server.release.tag_name,options.tag);
});
test('preview publication refuses conflicting draft assets and tags that move during upload',async t=>{
  const {options}=await fixture(t),loaded=await loadPreview(options.directory,options);
  assert.throws(()=>verifyInventory([{name:'someone-elses.txt'}],loaded.files),/Unexpected remote asset/);
  const first=loaded.files[0];assert.throws(()=>verifyInventory([{...first,state:'uploaded',digest:'sha256:'+'0'.repeat(64)}],loaded.files),/Existing asset differs/);
  let tagReads=0;const server=remote(options,undefined,({path})=>{if(path.includes('/git/ref/') && ++tagReads===2)return {object:{type:'commit',sha:'d'.repeat(40)}};});
  await assert.rejects(publishPreview({...options,api:server.api}),/Source tag moved/);
  assert.equal(server.writes.filter(w=>w.data?.draft===false).length,0);
  let otherReads=0;const other=remote(options,undefined,({path,release})=>{if(path.includes('/git/ref/') && ++otherReads===2)release.draft=false;});
  await assert.rejects(publishPreview({...options,api:other.api}),/Release changed/);
  assert.equal(other.writes.filter(w=>w.data?.draft===false).length,0);
});
test('preview publication rejects source/workflow/run mismatch and missing smoke checks',async t=>{
  const {options,metadata}=await fixture(t);
  await assert.rejects(loadPreview(options.directory,{...options,workflowSha:'d'.repeat(40)}));
  await assert.rejects(loadPreview(options.directory,{...options,runId:'124'}));
  metadata.sourceDirty=true;await writeFile(join(options.directory,'release.json'),JSON.stringify(metadata));
  await assert.rejects(loadPreview(options.directory,options));
  metadata.sourceDirty=false;await writeFile(join(options.directory,'release.json'),JSON.stringify(metadata));
  await writeFile(join(options.directory,'package-smoke.json'),'{}');await assert.rejects(loadPreview(options.directory,options));
});
test('preview publication refuses a saved draft published after the list snapshot',async t=>{
  const {options}=await fixture(t);
  const draft={id:8,tag_name:options.tag,name:'saved draft',body:options.commit,draft:true,assets:[]};
  const server=remote(options,draft,({method,path,release})=>{if(method==='GET' && path.endsWith('/releases/8'))release.draft=false;});
  await assert.rejects(publishPreview({...options,api:server.api}));
  assert.equal(server.writes.length,0);
});


test('publication entry accepts only main manual dispatch or its exact version tag push', () => {
  const base={tag:'v0.1.1',commit:'a'.repeat(40),workflowSha:'a'.repeat(40)};
  assert.doesNotThrow(()=>assertReleaseEvent({...base,eventName:'push',ref:'refs/tags/v0.1.1'}));
  assert.doesNotThrow(()=>assertReleaseEvent({...base,eventName:'workflow_dispatch',ref:'refs/heads/main',workflowSha:'b'.repeat(40)}));
  for(const event of [
    {eventName:'push',ref:'refs/heads/main'},
    {eventName:'push',ref:'refs/tags/v0.1.0'},
    {eventName:'push',ref:'refs/tags/v0.1.1',workflowSha:'b'.repeat(40)},
    {eventName:'workflow_dispatch',ref:'refs/heads/dev'},
    {eventName:'pull_request',ref:'refs/tags/v0.1.1'},
    {eventName:'repository_dispatch',ref:'refs/heads/main'},
  ])assert.throws(()=>assertReleaseEvent({...base,...event}));
});

async function windowsFixture(options,mac) {
  mac.source={sha256:'1'.repeat(64),files:[{path:'synthetic-source',sha256:'2'.repeat(64)}]};
  await writeFile(join(options.directory,'release.json'),JSON.stringify(mac));
  const artifact=`Lingji-${mac.version}-windows-x64-setup.exe`,bytes=Buffer.from('synthetic NSIS installer');
  const metadata={version:mac.version,channel:'preview',platform:'windows',architecture:'x64',artifact,sourceRevision:options.commit,sourceDirty:false,signing:'unsigned',frozenSourceBuild:true,
    sha256:createHash('sha256').update(bytes).digest('hex'),ci:mac.ci,source:mac.source,
    validation:{peVerified:true,installerSilentSmoke:true,installedAppProbe:true,resourcesVerified:true,uninstallVerified:true,productionSmoke:true,realAudioDevicesTested:false,realProvidersTested:false,freshMachineTested:false}};
  for(const [name,data] of [[artifact,bytes],['SHA256SUMS-windows-x64.txt',metadata.sha256+'  '+artifact+'\n'],['release-windows-x64.json',JSON.stringify(metadata)],['INSTALL-windows-x64.md','Windows synthetic guide'],['package-smoke-windows-x64.json',await readFile(join(options.directory,'package-smoke.json'))]])await writeFile(join(options.directory,name),data);
  options.requireWindows=true;return metadata;
}
test('dual-platform publication verifies diagnostics but publishes only installers from the same source and workflow',async t=>{
  const {options,metadata}=await fixture(t);const windows=await windowsFixture(options,metadata);
  const loaded=await loadPreview(options.directory,options);assert.equal(loaded.files.length,2);assert.equal(loaded.windows.sha256,windows.sha256);
  const server=remote(options);const result=await publishPreview({...options,api:server.api});
  assert.equal(result.assets.length,3);assert.ok(server.release.body.includes(windows.artifact));assert.match(server.release.body,/未进行 Windows 代码签名/);
});
test('dual-platform publication rejects missing Windows files and mismatched source, checksum or validation',async t=>{
  const {options,metadata}=await fixture(t);const windows=await windowsFixture(options,metadata);
  for(const mutate of [m=>{m.sourceRevision='c'.repeat(40);},m=>{m.source={...m.source,sha256:'0'.repeat(64)};},m=>{m.sha256='0'.repeat(64);},m=>{m.ci={...m.ci,runId:'999'};},m=>{m.validation={...m.validation,uninstallVerified:false};}]){
    const changed=structuredClone(windows);mutate(changed);await writeFile(join(options.directory,'release-windows-x64.json'),JSON.stringify(changed));await assert.rejects(loadPreview(options.directory,options));
  }
  await writeFile(join(options.directory,'release-windows-x64.json'),JSON.stringify(windows));
  await rm(join(options.directory,'INSTALL-windows-x64.md'));await assert.rejects(loadPreview(options.directory,options),/Unexpected or missing release files/);
});

test('three-platform publication keeps diagnostics in CI and publishes exactly three installers',async t=>{
  const {options,metadata}=await fixture(t);await windowsFixture(options,metadata);
  const artifact='Lingji-0.1.0-linux-amd64.deb',bytes=Buffer.from('synthetic DEB');
  const linux={version:metadata.version,channel:'preview',platform:'linux',architecture:'x64',artifact,sourceRevision:options.commit,sourceDirty:false,signing:'unsigned',frozenSourceBuild:true,
    sha256:createHash('sha256').update(bytes).digest('hex'),ci:metadata.ci,source:metadata.source,
    validation:{debVerified:true,installedAppProbe:true,resourcesVerified:true,uninstallVerified:true,productionSmoke:true,bundledAsrTested:true,realAudioDevicesTested:false,realProvidersTested:false,freshMachineTested:false}};
  const smoke={...JSON.parse(await readFile(join(options.directory,'package-smoke.json'))),bundledAsrConfigured:true};
  for(const [name,data] of [[artifact,bytes],['SHA256SUMS-linux-x64.txt',linux.sha256+'  '+artifact+'\n'],['release-linux-x64.json',JSON.stringify(linux)],['package-smoke-linux-x64.json',JSON.stringify(smoke)]])await writeFile(join(options.directory,name),data);
  options.requireLinux=true;
  const server=remote(options);const result=await publishPreview({...options,api:server.api});
  assert.deepEqual(result.assets.map(asset=>asset.name).sort(),[metadata.artifact,'Lingji-0.1.0-windows-x64-setup.exe',artifact,'preview-update.json'].sort());
  assert.match(server.release.body,/sudo apt install.*linux-amd64\.deb/);
  assert.ok(server.release.body.includes(linux.sha256));
  assert.match(server.release.body,/Source code \(zip \/ tar.gz\)/);
  assert.doesNotMatch(server.release.body,/按 INSTALL|用 SHA256SUMS/);
  for(const mutate of [m=>{m.sourceRevision='c'.repeat(40);},m=>{m.source={...m.source,sha256:'0'.repeat(64)};},m=>{m.sha256='0'.repeat(64);},m=>{m.validation.uninstallVerified=false;}]){
    const changed=structuredClone(linux);mutate(changed);await writeFile(join(options.directory,'release-linux-x64.json'),JSON.stringify(changed));
    const rejected=remote(options);await assert.rejects(publishPreview({...options,api:rejected.api}));assert.equal(rejected.writes.length,0);
  }
  await writeFile(join(options.directory,'release-linux-x64.json'),JSON.stringify(linux));
  await rm(join(options.directory,artifact));await assert.rejects(loadPreview(options.directory,options));
});

test('release notes accept existing headings and refuse empty changes before writing a release',async t=>{
  const {options,metadata}=await fixture(t);
  const args={tag:options.tag,commit:options.commit,workflowSha:options.workflowSha,metadata,runUrl:metadata.ci.runUrl};
  for(const heading of ['本版变化','本版行为','修复与设置','版本改动与修复']){
    const body=previewNotes({...args,guide:`# Release\r\n\r\n## ${heading}\r\n- 修复正文遗漏\r\n\r\n## 验证\r\nnot part of changes`});
    assert.match(body,/^## 版本改动与修复\n- 修复正文遗漏/);assert.doesNotMatch(body,/not part of changes/);
  }
  for(const guide of ['# No changes','## 本版变化\n\n## 安装\nSteps']){
    await writeFile(join(options.directory,'INSTALL-macos-arm64.md'),guide);
    const server=remote(options);await assert.rejects(publishPreview({...options,api:server.api}),/changes and fixes are required/);assert.equal(server.writes.length,0);
  }
});

test('Linux collector preserves package evidence and binds it to the current CI run',async t=>{
  const root=await mkdtemp(join(tmpdir(),'linux-collect-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'dist/releases/0.1.28/linux-x64');await mkdir(directory,{recursive:true});
  const metadata={artifact:'Lingji-0.1.28-linux-amd64.deb',sourceRevision:'a'.repeat(40),sourceDirty:false,frozenSourceBuild:true};
  const names=[metadata.artifact,'SHA256SUMS-linux-x64.txt','release-linux-x64.json','package-smoke-linux-x64.json'];
  for(const name of names)await writeFile(join(directory,name),name==='release-linux-x64.json'?JSON.stringify(metadata):'test evidence');
  const script=fileURLToPath(new URL('../scripts/collect-preview-artifacts.mjs',import.meta.url));
  const env={...process.env,RELEASE_VERSION:'0.1.28',SOURCE_SHA:metadata.sourceRevision,WORKFLOW_SHA:'b'.repeat(40),GITHUB_REPOSITORY:'owner/repo',GITHUB_RUN_ID:'123'};
  execFileSync(process.execPath,[script,'linux'],{cwd:root,env});
  assert.deepEqual((await readdir(join(root,'preview-artifacts'))).sort(),names.sort());
  const saved=JSON.parse(await readFile(join(root,'preview-artifacts/release-linux-x64.json')));
  assert.deepEqual(saved.ci,{repository:'owner/repo',runId:'123',runUrl:'https://github.com/owner/repo/actions/runs/123',workflowSha:env.WORKFLOW_SHA,sourceRevision:metadata.sourceRevision});
  assert.throws(()=>execFileSync(process.execPath,[script,'linux'],{cwd:root,env:{...env,SOURCE_SHA:'c'.repeat(40)},stdio:'pipe'}));
});

test('desktop release versions match preview overrides and every workspace', async () => {
  const {readFile}=await import('node:fs/promises');
  const json=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url),'utf8'));
  const root=await json('package.json'),base=await json('apps/desktop/src-tauri/tauri.conf.json'),preview=await json('apps/desktop/src-tauri/tauri.preview.conf.json');
  for(const path of ['package-lock.json','apps/desktop/package.json','apps/web/package.json'])assert.equal((await json(path)).version,root.version,path);
  assert.equal(base.version,root.version,'base Tauri version');
  assert.equal(preview.version,root.version,'preview Tauri version');
  assert.equal(preview.bundle.macOS.bundleVersion,base.bundle.macOS.bundleVersion,'preview macOS build');
  const cargo=await readFile(new URL('../apps/desktop/src-tauri/Cargo.toml',import.meta.url),'utf8');
  assert.equal(cargo.match(/^version = "([^"]+)"/m)[1],root.version,'Cargo package');
  const lock=await readFile(new URL('../apps/desktop/src-tauri/Cargo.lock',import.meta.url),'utf8');
  for(const content of [lock,lock.replace(/\r?\n/g,'\r\n')])assert.equal(content.match(/name = "tts-client"\r?\nversion = "([^"]+)"/)[1],root.version,'Cargo lock');
});

test('current preview guide contains changes accepted by the real publisher', async t => {
  const {options,metadata}=await fixture(t);
  const {version}=JSON.parse(await readFile(new URL('../apps/desktop/package.json',import.meta.url),'utf8'));
  const guide=await readFile(new URL(`../docs/releases/v${version}-preview.md`,import.meta.url),'utf8');
  const notes=previewNotes({...options,tag:`v${version}`,metadata:{...metadata,version,artifact:`Lingji-${version}-macos-arm64.dmg`},runUrl:'https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/1',guide});
  assert.match(notes,/## 版本改动与修复\n[\s\S]+\n## 下载与安装/);
});

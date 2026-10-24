import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPreview, publishPreview, verifyInventory, assertReleaseEvent } from '../scripts/publish-preview-release.mjs';

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
  for(const [name,data] of [[artifact,bytes],['SHA256SUMS.txt',metadata.sha256+'  '+artifact+'\n'],['release.json',JSON.stringify(metadata)],['INSTALL-macos-arm64.md','Synthetic installation guide'],['package-smoke.json',JSON.stringify(smoke)]])await writeFile(join(directory,name),data);
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
  const {options,metadata}=await fixture(t);assert.equal((await loadPreview(options.directory,options)).files.length,5);
  await writeFile(join(options.directory,metadata.artifact),'changed');
  const server=remote(options);await assert.rejects(publishPreview({...options,api:server.api}));assert.equal(server.writes.length,0);
});
test('preview publication uploads five verified assets and only then publishes',async t=>{
  const {options}=await fixture(t),server=remote(options);const result=await publishPreview({...options,api:server.api});
  assert.equal(result.published,true);assert.equal(result.assets.length,5);assert.equal(server.release.prerelease,true);
  assert.equal(server.writes.filter(w=>w.upload).length,5);assert.equal(server.writes.at(-1).data.draft,false);
  const after=server.writes.length;await assert.rejects(publishPreview({...options,api:server.api}),/Published release/);assert.equal(server.writes.length,after);
});
test('preview publication adopts matching saved draft and resumes identical partial upload',async t=>{
  const {options}=await fixture(t);const loaded=await loadPreview(options.directory,options),file=loaded.files[0];
  const draft={id:8,tag_name:'untagged-abcd',name:'聆记 v0.1.0 · 首次公开测试版 / First Public Preview',body:'Frozen '+options.commit,draft:true,
    assets:[{name:file.name,size:file.size,digest:file.digest,state:'uploaded'}]};
  const server=remote(options,draft);await publishPreview({...options,api:server.api});
  assert.equal(server.writes[0].method,'PATCH');assert.equal(server.writes[0].path,'/repos/owner/repo/releases/8');
  assert.equal(server.writes.filter(w=>w.upload).length,4);assert.equal(server.release.tag_name,options.tag);
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
  const artifact=`Lingji-${mac.version}-windows-x64-setup.exe`,bytes=Buffer.from('synthetic NSIS installer');
  const metadata={version:mac.version,channel:'preview',platform:'windows',architecture:'x64',artifact,sourceRevision:options.commit,sourceDirty:false,signing:'unsigned',frozenSourceBuild:true,
    sha256:createHash('sha256').update(bytes).digest('hex'),ci:mac.ci,
    validation:{peVerified:true,installerSilentSmoke:true,installedAppProbe:true,resourcesVerified:true,uninstallVerified:true,productionSmoke:true,realAudioDevicesTested:false,realProvidersTested:false,freshMachineTested:false}};
  for(const [name,data] of [[artifact,bytes],['SHA256SUMS-windows-x64.txt',metadata.sha256+'  '+artifact+'\n'],['release-windows-x64.json',JSON.stringify(metadata)],['INSTALL-windows-x64.md','Windows synthetic guide'],['package-smoke-windows-x64.json',await readFile(join(options.directory,'package-smoke.json'))]])await writeFile(join(options.directory,name),data);
  options.requireWindows=true;return metadata;
}
test('dual-platform publication requires ten verified files from the same source and workflow',async t=>{
  const {options,metadata}=await fixture(t);const windows=await windowsFixture(options,metadata);
  const loaded=await loadPreview(options.directory,options);assert.equal(loaded.files.length,10);assert.equal(loaded.windows.sha256,windows.sha256);
  const server=remote(options);const result=await publishPreview({...options,api:server.api});
  assert.equal(result.assets.length,10);assert.ok(server.release.body.includes(windows.artifact));assert.match(server.release.body,/未进行 Windows 代码签名/);
});
test('dual-platform publication rejects missing Windows files and mismatched source, checksum or validation',async t=>{
  const {options,metadata}=await fixture(t);const windows=await windowsFixture(options,metadata);
  for(const mutate of [m=>{m.sourceRevision='c'.repeat(40);},m=>{m.sha256='0'.repeat(64);},m=>{m.ci={...m.ci,runId:'999'};},m=>{m.validation={...m.validation,uninstallVerified:false};}]){
    const changed=structuredClone(windows);mutate(changed);await writeFile(join(options.directory,'release-windows-x64.json'),JSON.stringify(changed));await assert.rejects(loadPreview(options.directory,options));
  }
  await writeFile(join(options.directory,'release-windows-x64.json'),JSON.stringify(windows));
  await rm(join(options.directory,'INSTALL-windows-x64.md'));await assert.rejects(loadPreview(options.directory,options),/Unexpected or missing release files/);
});

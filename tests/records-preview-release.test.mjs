import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPreview, publishPreview, verifyInventory } from '../scripts/publish-preview-release.mjs';

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

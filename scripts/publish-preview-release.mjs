// Only the explicitly dispatched CI publish job receives a write token.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const title=tag=>tag==='v0.1.0'?`聆记 ${tag} · 首次公开测试版 / First Public Preview`:`聆记 ${tag} · 公开测试版 / Public Preview`;
const sha=value=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value);
export async function loadPreview(directory,{tag,commit,repository,workflowSha,runId,requireWindows=false}) {
  assert.match(tag,/^v\d+\.\d+\.\d+$/);
  assert.ok(sha(commit) && sha(workflowSha),'Full source and workflow SHAs required');
  assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(runId,/^\d+$/);
  const metadata=JSON.parse(await readFile(join(directory,'release.json'),'utf8'));
  const artifact=`Lingji-${tag.slice(1)}-macos-arm64.dmg`;
  assert.deepEqual([metadata.version,metadata.channel,metadata.platform,metadata.architecture,metadata.artifact,metadata.sourceRevision,metadata.sourceDirty,metadata.signing,metadata.notarized,metadata.frozenSourceBuild],
    [tag.slice(1),'preview','macos','arm64',artifact,commit,false,'ad-hoc',false,true]);
  const runUrl=`https://github.com/${repository}/actions/runs/${runId}`;
  assert.deepEqual(metadata.ci,{repository,runId,runUrl,workflowSha,sourceRevision:commit});
  for(const key of ['imageVerified','copiedAppSignatureVerified','productionSmoke'])assert.equal(metadata.validation?.[key],true);
  for(const key of ['realAudioDevicesTested','realProvidersTested','freshMachineTested'])assert.equal(metadata.validation?.[key],false);
  const names=[artifact,'SHA256SUMS.txt','release.json','INSTALL-macos-arm64.md','package-smoke.json'];
  const windows=requireWindows?await loadWindowsPreview(directory,{tag,commit,repository,workflowSha,runId}):undefined;
  if(windows){
    assert.match(metadata.source?.sha256,/^[a-f0-9]{64}$/);assert.ok(metadata.source.files.length>0);
    assert.deepEqual(windows.metadata.source,metadata.source,'Platform source manifests differ');
    names.push(...windows.names);
  }
  assert.deepEqual((await readdir(directory)).sort(),[...names].sort(),'Unexpected or missing release files');
  const files=await Promise.all(names.map(async name=>{const bytes=await readFile(join(directory,name));assert.ok(bytes.length>0);return {name,bytes,size:bytes.length,digest:'sha256:'+hash(bytes)};}));
  assert.equal(files[0].digest,'sha256:'+metadata.sha256);
  assert.equal(files[1].bytes.toString().trim(),`${metadata.sha256}  ${artifact}`);
  const smoke=JSON.parse(files[4].bytes);
  for(const key of ['packagedApp','independentBackend','restartPersistence','stableWebviewProfile','parentOwnsBackend','localAccount','devAccountDisabled'])assert.equal(smoke[key],true);
  assert.equal(smoke.developerBackendRequests,0);
  assert.equal(smoke.realAudioDevicesOpened,false);assert.equal(smoke.realProvidersInvoked,false);
  return {metadata,files,runUrl,guide:files[3].bytes.toString('utf8'),windows:windows?.metadata};
}
export async function loadWindowsPreview(directory,{tag,commit,repository,workflowSha,runId}) {
  const metadata=JSON.parse(await readFile(join(directory,'release-windows-x64.json'),'utf8'));
  const artifact=`Lingji-${tag.slice(1)}-windows-x64-setup.exe`;
  assert.deepEqual([metadata.version,metadata.channel,metadata.platform,metadata.architecture,metadata.artifact,metadata.sourceRevision,metadata.sourceDirty,metadata.signing,metadata.frozenSourceBuild],
    [tag.slice(1),'preview','windows','x64',artifact,commit,false,'unsigned',true]);
  const runUrl=`https://github.com/${repository}/actions/runs/${runId}`;
  assert.deepEqual(metadata.ci,{repository,runId,runUrl,workflowSha,sourceRevision:commit});
  for(const key of ['peVerified','installerSilentSmoke','installedAppProbe','resourcesVerified','uninstallVerified','productionSmoke'])assert.equal(metadata.validation?.[key],true,key);
  for(const key of ['realAudioDevicesTested','realProvidersTested','freshMachineTested'])assert.equal(metadata.validation?.[key],false,key);
  const bytes=await readFile(join(directory,artifact));
  assert.equal(hash(bytes),metadata.sha256,'Windows installer hash differs');
  assert.equal((await readFile(join(directory,'SHA256SUMS-windows-x64.txt'),'utf8')).trim(),`${metadata.sha256}  ${artifact}`);
  const smoke=JSON.parse(await readFile(join(directory,'package-smoke-windows-x64.json'),'utf8'));
  for(const key of ['packagedApp','independentBackend','restartPersistence','stableWebviewProfile','parentOwnsBackend','localAccount','devAccountDisabled'])assert.equal(smoke[key],true,key);
  assert.equal(smoke.developerBackendRequests,0);assert.equal(smoke.realAudioDevicesOpened,false);assert.equal(smoke.realProvidersInvoked,false);
  return {metadata,names:[artifact,'SHA256SUMS-windows-x64.txt','release-windows-x64.json','INSTALL-windows-x64.md','package-smoke-windows-x64.json']};
}

export function verifyInventory(assets,files,{complete=false}={}) {
  assert.ok(Array.isArray(assets));
  const seen=new Set();
  for(const asset of assets) {
    assert.ok(!seen.has(asset.name),'Duplicate remote asset');seen.add(asset.name);
    const file=files.find(file=>file.name===asset.name);
    assert.ok(file,'Unexpected remote asset; preserve and investigate');
    assert.equal(asset.state,'uploaded');assert.equal(asset.size,file.size);assert.equal(asset.digest,file.digest,'Existing asset differs; never overwrite');
  }
  if(complete)assert.equal(seen.size,files.length,'Incomplete release inventory');
}
export function previewNotes({tag,commit,workflowSha,metadata,runUrl,guide='',windows}) {
  const changes=guide.replace(/\r\n/g,'\n').split('\n## 本版变化\n')[1]?.split('\n## ')[0].trim()
    || '本版变更请参阅随包 INSTALL-macos-arm64.md。';
  return `公开测试版：源码 + macOS Apple Silicon${windows?' + Windows x64':''} 测试安装包。\n\n`+
    `### 下载与安装\nmacOS 14.6+、Apple Silicon（M 系列）。下载 ${metadata.artifact}，按 INSTALL-macos-arm64.md 安装，并用 SHA256SUMS.txt 校验。内置 Node 24 后台，无需另装运行时。\n\n`+
    `**ad-hoc 签名，未进行 Developer ID 签名及 Apple 公证。** Preview 与 Alpha 使用相同应用标识；先结束录制、等待补传、退出并备份，勿同时运行。\n\n`+
    (windows?`### Windows 下载与安装\nWindows 10/11 x64：下载 ${windows.artifact}，按 INSTALL-windows-x64.md 安装，用 SHA256SUMS-windows-x64.txt 校验。当前用户安装，内置 Node 24 与 WebView2 离线安装组件。**未进行 Windows 代码签名。** 关闭窗口后常驻托盘；升级或卸载前请先结束录音并从托盘退出。\nWindows SHA-256：\`${windows.sha256}\`\n\n`:'')+
    `### 本版变化\n${changes}\n\n`+
    `### Actions 构建与验证\n由 [GitHub Actions](${runUrl}) 在 macOS ARM runner${windows?' 与 Windows x64 runner':''} 构建。构建阶段运行 Node/Rust 回归、ESLint、类型与文档检查；DMG、arm64、签名结构、包内后台及隔离启动/重启检查通过。${windows?'Windows 静默安装、安装资源哈希、x64 主程序、包内独立后台、隔离启动/重启及卸载检查通过。':''}实际执行记录以该 run 为准。\n\n`+
    `源码 SHA：\`${commit}\`\n工作流 SHA：\`${workflowSha}\`\nDMG SHA-256：\`${metadata.sha256}\`\n\n`+
    `### 已知边界\n尚未验证真实设备长会议、真实 ASR/LLM 质量、全新 Mac 首次安装、完整 App 冷启动、PG/S3${windows?' 或全新 Windows 电脑交互安装、Linux 安装':' 或 Windows/Linux 安装'}。此测试包不替代正式签名发版。\n\n`+
    `### English\nPublic preview ${tag}: source code and a macOS Apple Silicon test installer (macOS 14.6+)${windows?' plus a Windows x64 installer (Windows 10/11)':''}, built and published by GitHub Actions. See INSTALL-macos-arm64.md${windows?' and INSTALL-windows-x64.md':''} for this version's changes.\n\n`+
    `**Ad-hoc signed; not Developer ID signed or notarized.** Back up existing data and do not run Preview and Alpha concurrently. Real-meeting quality, full native cold startup and fresh-machine acceptance remain unverified.\n`;
}
async function sourceCommit(api,base,tag) {
  let object=(await api('GET',`${base}/git/ref/tags/${tag}`)).object;
  for(let i=0;object?.type==='tag' && i<5;i++) {
    assert.ok(sha(object.sha));object=(await api('GET',`${base}/git/tags/${object.sha}`)).object;
  }
  assert.equal(object?.type,'commit');assert.ok(sha(object.sha));return object.sha;
}
export async function publishPreview(options) {
  const {api,tag,commit,workflowSha,repository}=options;
  const {metadata,files,runUrl,guide,windows}=await loadPreview(options.directory,options);
  const base=`/repos/${repository}`;
  assert.equal(await sourceCommit(api,base,tag),commit,'Source tag moved');
  const candidates=[];
  for(let page=1;page<=10;page++) {
    const releases=await api('GET',`${base}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(releases));
    candidates.push(...releases.filter(r=>r.tag_name===tag || (r.draft && r.name===title(tag) && r.body?.includes(commit))));
    if(releases.length<100)break;
    assert.ok(page<10,'Release list truncated');
  }
  assert.ok(candidates.length<=1,'Ambiguous existing release');
  let release=candidates[0];
  if(release) {
    assert.ok(release.draft===true,'Published release is immutable to this workflow');
    assert.ok(release.body?.includes(commit),'Existing draft source differs');
    verifyInventory(release.assets,files);
  }
  const body=previewNotes({tag,commit,workflowSha,metadata,runUrl,guide,windows});
  const payload={tag_name:tag,target_commitish:commit,name:title(tag),body,draft:true,prerelease:true,make_latest:'false'};
  if(!release)release=await api('POST',`${base}/releases`,payload);
  else {
    const current=await api('GET',`${base}/releases/${release.id}`);
    assert.equal(current.draft,true,'Draft was published after list snapshot');
    assert.equal(current.tag_name,release.tag_name,'Draft tag changed');
    assert.ok(current.body?.includes(commit),'Draft source changed');verifyInventory(current.assets,files);
    release=await api('PATCH',`${base}/releases/${release.id}`,payload);
  }
  assert.ok(Number.isSafeInteger(release.id) && release.id>0);const id=release.id;
  for(const file of files) {
    release=await api('GET',`${base}/releases/${id}`);
    assert.equal(release.draft,true,'Release changed during upload');assert.equal(release.tag_name,tag);
    verifyInventory(release.assets,files);
    if(!release.assets.some(asset=>asset.name===file.name))await api('POST',`${base}/releases/${id}/assets?name=${encodeURIComponent(file.name)}`,file.bytes,true);
  }
  release=await api('GET',`${base}/releases/${id}`);
  assert.equal(release.draft,true);verifyInventory(release.assets,files,{complete:true});
  assert.equal(await sourceCommit(api,base,tag),commit,'Source tag moved before publication');
  release=await api('GET',`${base}/releases/${id}`);
  assert.equal(release.draft,true,'Release changed before publication');assert.equal(release.tag_name,tag);
  verifyInventory(release.assets,files,{complete:true});
  await api('PATCH',`${base}/releases/${id}`,{...payload,draft:false});
  const published=await api('GET',`${base}/releases/${id}`);
  assert.equal(published.draft,false);assert.equal(published.prerelease,true);assert.equal(published.tag_name,tag);
  verifyInventory(published.assets,files,{complete:true});
  return {published:true,url:published.html_url,tag,sourceRevision:commit,workflowSha,runUrl,assets:published.assets.map(({name,size,digest})=>({name,size,digest}))};
}
export function assertReleaseEvent({eventName,ref,tag,commit,workflowSha}) {
  assert.match(tag,/^v\d+\.\d+\.\d+$/);
  assert.ok(sha(commit) && sha(workflowSha),'Full source and workflow SHAs required');
  const manual=eventName==='workflow_dispatch' && ref==='refs/heads/main';
  const tagPush=eventName==='push' && ref===`refs/tags/${tag}` && commit===workflowSha;
  assert.ok(manual || tagPush,'Only main manual dispatch or a matching source tag push may publish');
}

async function main() {
  assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true');
  assertReleaseEvent({eventName:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,tag:process.env.RELEASE_TAG,commit:process.env.RELEASE_SHA,workflowSha:process.env.RELEASE_WORKFLOW_SHA});
  const token=process.env.GH_TOKEN;assert.ok(token,'CI write token required');
  const repository=process.env.GITHUB_REPOSITORY;
  const api=async (method,path,data,upload=false)=>{
    assert.ok(path.startsWith(`/repos/${repository}/`));
    const response=await fetch(`https://${upload?'uploads':'api'}.github.com${path}`,{method,redirect:'error',signal:AbortSignal.timeout(120000),
      headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10',...(data?{'Content-Type':upload?'application/octet-stream':'application/json'}:{})},
      ...(data?{body:upload?data:JSON.stringify(data)}:{})});
    if(!response.ok)throw new Error(`GitHub ${method} request failed: HTTP ${response.status}`);
    return response.json();
  };
  const result=await publishPreview({api,repository,tag:process.env.RELEASE_TAG,commit:process.env.RELEASE_SHA,workflowSha:process.env.RELEASE_WORKFLOW_SHA,
    requireWindows:true,runId:process.env.GITHUB_RUN_ID,directory:resolve(process.argv[2]||'preview-artifacts')});
  await writeFile('preview-publication-receipt.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});

// Only the explicitly dispatched CI publish job receives a write token.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const title=tag=>tag==='v0.1.0'?`聆记 ${tag} · 首次公开测试版 / First Public Preview`:`聆记 ${tag} · 公开测试版 / Public Preview`;
const sha=value=>typeof value==='string' && /^[a-f0-9]{40}$/.test(value);
export async function loadPreview(directory,{tag,commit,repository,workflowSha,runId,requireWindows=false,requireLinux=false}) {
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
  const linux=requireLinux?await loadLinuxPreview(directory,{tag,commit,repository,workflowSha,runId}):undefined;
  if(linux){assert.deepEqual(linux.metadata.source,metadata.source,'Platform source manifests differ');names.push(...linux.names);}
  assert.deepEqual((await readdir(directory)).sort(),[...names].sort(),'Unexpected or missing release files');
  const files=await Promise.all(names.map(async name=>{const bytes=await readFile(join(directory,name));assert.ok(bytes.length>0);return {name,bytes,size:bytes.length,digest:'sha256:'+hash(bytes)};}));
  assert.equal(files[0].digest,'sha256:'+metadata.sha256);
  assert.equal(files[1].bytes.toString().trim(),`${metadata.sha256}  ${artifact}`);
  const smoke=JSON.parse(files[4].bytes);
  for(const key of ['packagedApp','independentBackend','restartPersistence','stableWebviewProfile','parentOwnsBackend','localAccount','devAccountDisabled'])assert.equal(smoke[key],true);
  assert.equal(smoke.developerBackendRequests,0);
  assert.equal(smoke.realAudioDevicesOpened,false);assert.equal(smoke.realProvidersInvoked,false);
  return {metadata,files:files.filter(file=>[artifact,windows?.metadata.artifact,linux?.metadata.artifact].includes(file.name)),runUrl,guide:files[3].bytes.toString('utf8'),windows:windows?.metadata,linux:linux?.metadata};
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

export async function loadLinuxPreview(directory,{tag,commit,repository,workflowSha,runId}) {
  const metadata=JSON.parse(await readFile(join(directory,'release-linux-x64.json'),'utf8'));
  const artifact=`Lingji-${tag.slice(1)}-linux-amd64.deb`;
  assert.deepEqual([metadata.version,metadata.channel,metadata.platform,metadata.architecture,metadata.artifact,metadata.sourceRevision,metadata.sourceDirty,metadata.signing,metadata.frozenSourceBuild],
    [tag.slice(1),'preview','linux','x64',artifact,commit,false,'unsigned',true]);
  const runUrl=`https://github.com/${repository}/actions/runs/${runId}`;
  assert.deepEqual(metadata.ci,{repository,runId,runUrl,workflowSha,sourceRevision:commit});
  assert.match(metadata.source?.sha256,/^[a-f0-9]{64}$/);assert.ok(metadata.source.files.length>0);
  for(const key of ['debVerified','installedAppProbe','resourcesVerified','uninstallVerified','productionSmoke','bundledAsrTested'])assert.equal(metadata.validation?.[key],true,key);
  for(const key of ['realAudioDevicesTested','realProvidersTested','freshMachineTested'])assert.equal(metadata.validation?.[key],false,key);
  assert.equal(hash(await readFile(join(directory,artifact))),metadata.sha256,'Linux installer hash differs');
  assert.equal((await readFile(join(directory,'SHA256SUMS-linux-x64.txt'),'utf8')).trim(),`${metadata.sha256}  ${artifact}`);
  const smoke=JSON.parse(await readFile(join(directory,'package-smoke-linux-x64.json'),'utf8'));
  for(const key of ['packagedApp','independentBackend','restartPersistence','stableWebviewProfile','parentOwnsBackend','localAccount','devAccountDisabled','bundledAsrConfigured'])assert.equal(smoke[key],true,key);
  assert.equal(smoke.developerBackendRequests,0);assert.equal(smoke.realAudioDevicesOpened,false);assert.equal(smoke.realProvidersInvoked,false);
  return {metadata,names:[artifact,'SHA256SUMS-linux-x64.txt','release-linux-x64.json','package-smoke-linux-x64.json']};
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
export function previewNotes({tag,commit,workflowSha,metadata,runUrl,guide='',windows,linux}) {
  const changes=('\n'+guide.replace(/\r\n/g,'\n')).match(/\n## (?:本版变化|本版行为|修复与设置|版本改动与修复)[ \t]*\n([\s\S]*?)(?=\n## |$)/)?.[1].trim();
  assert.ok(changes,'Version changes and fixes are required before publication');
  const repository=runUrl.split('/actions/runs/')[0];
  const guideUrl=`${repository}/blob/${commit}/docs/releases/${tag}-preview.md`;
  const installers=[metadata,windows,linux].filter(Boolean);
  const downloads=installers.map(item=>`| ${item.platform} ${item.architecture} | [${item.artifact}](${repository}/releases/download/${tag}/${item.artifact}) |`).join('\n');
  const checksums=installers.map(item=>`${item.sha256}  ${item.artifact}`).join('\n');
  return `## 版本改动与修复\n${changes}\n\n`+
    `## 下载与安装\n| 系统 | 安装包 |\n| --- | --- |\n${downloads}\n\n`+
    `macOS 14.6+ Apple Silicon：打开 DMG，将应用拖入 Applications。Windows 10/11 x64：运行 EXE，选择安装位置、快捷方式和本地模型（默认勾选）。`+
    (linux?`Linux x64：本版在 Ubuntu 24.04 构建及验证，下载后运行 \`sudo apt install ./`+linux.artifact+`\`，由 apt 安装系统依赖。其他发行版与旧版系统兼容性尚未验证。`:'')+
    `各安装包内置 Node 24 和离线转录资源，无需另装 Node 或 Python。\n\n`+
    `升级前结束录音、完成补传、退出应用并备份数据。macOS 使用 ad-hoc 签名，未进行 Developer ID 签名及 Apple 公证；`+
    (windows?'**未进行 Windows 代码签名。** ':'')+`详细操作见[本版安装说明](${guideUrl})。\n\n`+
    `## SHA-256\n下载后使用 macOS 的 \`shasum -a 256 <文件>\`、Linux 的 \`sha256sum <文件>\` 或 PowerShell 的 \`Get-FileHash <文件> -Algorithm SHA256\` 核对：\n\n\`\`\`text\n${checksums}\n\`\`\`\n\n`+
    `## 源码与验证\nSource code (zip / tar.gz) 由 GitHub 按标签提供。源码 SHA：\`${commit}\`；工作流 SHA：\`${workflowSha}\`。\n\n`+
    `由 [GitHub Actions](${runUrl}) 构建，校验来源、安装包摘要和启动/重启结果后发布；验证报告、源码清单和安装文档保留在 Actions artifacts，Release 附件包含成品安装包与自动下载校验清单。\n\n`+
    `## 已知边界\n真实设备长会议、真实 ASR/LLM 质量、全新电脑交互安装、PG/S3 和 Linux 实机采音尚未验证。Linux PipeWire 系统音频、麦克风与文件导入需在目标设备验收；Linux 关闭窗口进入退出确认流程，不提供 macOS/Windows 的托盘常驻行为。测试包不替代正式签名发行。\n`;
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
  const {metadata,files,runUrl,guide,windows,linux}=await loadPreview(options.directory,options);
  const body=previewNotes({tag,commit,workflowSha,metadata,runUrl,guide,windows,linux});
  const updateBytes=Buffer.from(JSON.stringify({tag_name:tag,draft:false,body,sourceRevision:commit,assets:files.map(file=>({name:file.name,state:'uploaded',size:file.size,digest:file.digest,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${file.name}`}))},null,2)+'\n');
  files.push({name:'preview-update.json',bytes:updateBytes,size:updateBytes.length,digest:'sha256:'+hash(updateBytes)});
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
    requireWindows:true,requireLinux:true,runId:process.env.GITHUB_RUN_ID,directory:resolve(process.argv[2]||'preview-artifacts')});
  await writeFile('preview-publication-receipt.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});

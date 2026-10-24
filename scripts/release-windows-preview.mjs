import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {access,copyFile,mkdir,mkdtemp,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readReleaseSource,snapshotReleaseSource,releaseHash} from './release-source.mjs';

assert.equal(process.platform,'win32','Windows packaging requires Windows CI or a Windows development host');
assert.equal(process.arch,'x64','This preview targets Windows x64');
assert.equal(process.env.GITHUB_ACTIONS,'true','Installer probes require disposable GitHub-hosted Windows CI');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted','Never replace a developer current-user installation during package verification');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:8*1024*1024}).toString().trim();
const sourceRevision=git('rev-parse','--verify',`${process.env.TTS_RELEASE_SOURCE_REF||'HEAD'}^{commit}`);
const readSource=path=>readReleaseSource(root,sourceRevision,path);
const config=JSON.parse(await readSource('apps/desktop/src-tauri/tauri.preview.conf.json'));
assert.match(config.version,/^\d+\.\d+\.\d+$/);
const output=join(root,'dist/releases',config.version,'windows-x64');
await mkdir(dirname(output),{recursive:true});
await assert.rejects(access(output),{code:'ENOENT'},'A release directory cannot be overwritten');
const scratch=await mkdtemp(join(tmpdir(),'lingji-windows-build-'));
const stage=await mkdtemp(join(dirname(output),'.windows-build-'));
const npmCli=process.env.npm_execpath||join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
await access(npmCli);
async function run(command,args,cwd,env={}){
 if(command==='npm'){command=process.execPath;args=[npmCli,...args];}
 await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${command} failed (${code})`)));
 });
}
try{
 const frozen=join(scratch,'source');const source=await snapshotReleaseSource({root,ref:sourceRevision,destination:frozen});
 assert.equal((await snapshotReleaseSource({root,ref:sourceRevision})).sha256,source.sha256);
 await symlink(join(root,'node_modules'),join(frozen,'node_modules'),'junction');
 for(const workspace of ['apps/web','apps/desktop']){
  const modules=join(root,workspace,'node_modules');try{await access(modules);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  await symlink(modules,join(frozen,workspace,'node_modules'),'junction');
 }
 await mkdir(join(frozen,'.agent-runtime'),{recursive:true});
 const runtimeCache=join(root,'.agent-runtime/runtimes');
 try{await access(runtimeCache);await symlink(runtimeCache,join(frozen,'.agent-runtime/runtimes'),'junction');}catch(error){if(error.code!=='ENOENT')throw error;}
 await run('npm',['run','build:web'],frozen);
 await run(process.execPath,['scripts/installer-background.mjs','--check'],frozen);
 await run('npm',['run','build:native','--workspace','@tts/desktop','--','--config','src-tauri/tauri.preview.conf.json','--config','src-tauri/tauri.windows.conf.json','--bundles','nsis'],frozen);
 const bundle=join(frozen,'apps/desktop/src-tauri/target/release/bundle/nsis');
 const installers=(await readdir(bundle)).filter(name=>name.endsWith('.exe'));assert.equal(installers.length,1);
 const artifact=`Lingji-${config.version}-windows-x64-setup.exe`;
 await copyFile(join(bundle,installers[0]),join(stage,artifact));
 const bytes=await readFile(join(stage,artifact));assert.equal(bytes.toString('ascii',0,2),'MZ');
 assert.equal(bytes.readUInt16LE(bytes.readUInt32LE(0x3c)+4),0x14c,'NSIS bootstrap is a PE32 executable');
 await run('pwsh.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(frozen,'scripts/test-windows-installer-ui.ps1'),'-Installer',join(stage,artifact),'-Root',join(scratch,'installer-preview')],frozen);
 const installerSmoke=join(stage,'installer-smoke.json');
 await run('pwsh.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(frozen,'scripts/test-windows-installer.ps1'),'-Installer',join(stage,artifact),'-Root',join(scratch,'installation'),'-Output',installerSmoke,'-ProbeScript',join(frozen,'scripts/test-standalone-package.mjs'),'-SourceRoot',frozen],frozen);
 const install=JSON.parse(await readFile(installerSmoke));
 assert.equal(install.installed,true);assert.equal(install.uninstalled,true);assert.equal(install.resourcesVerified,true);
 const smokePath=join(stage,'package-smoke-windows-x64.json');
 await copyFile(install.packageSmoke,smokePath);
 const smoke=JSON.parse(await readFile(smokePath));
 for(const key of ['packagedApp','independentBackend','restartPersistence','stableWebviewProfile','parentOwnsBackend','localAccount','devAccountDisabled'])assert.equal(smoke[key],true,key);
 assert.equal(smoke.realAudioDevicesOpened,false);assert.equal(smoke.realProvidersInvoked,false);
 const metadata={version:config.version,channel:'preview',platform:'windows',architecture:'x64',artifact,sourceRevision,sourceDirty:false,frozenSourceBuild:true,signing:'unsigned',sha256:releaseHash(bytes),source,
  runtime:{node:smoke.node,sqlite:smoke.sqlite},validation:{peVerified:true,installerSilentSmoke:true,installedAppProbe:true,resourcesVerified:true,uninstallVerified:true,productionSmoke:true,realAudioDevicesTested:false,realProvidersTested:false,freshMachineTested:false},
  timestamp:new Date().toISOString()};
 await writeFile(join(stage,'release-windows-x64.json'),JSON.stringify(metadata,null,2)+'\n');
 await writeFile(join(stage,'SHA256SUMS-windows-x64.txt'),`${metadata.sha256}  ${artifact}\n`);
 const notes=(await readSource(`docs/releases/v${config.version}-preview.md`)).toString();
 const guide=`# 聆记 ${config.version} Windows x64 测试版\n\n下载 ${artifact}，用 SHA256SUMS-windows-x64.txt 核对。Windows 10/11 x64；运行安装器，选择当前用户安装位置和桌面快捷方式，安装后可启动聆记。包内有 Node 24 与 WebView2 离线安装组件，无需另装 Node。\n\n此测试包未进行 Windows 代码签名。关闭主窗口会常驻系统托盘，录音与整理继续运行；从托盘打开窗口或安全退出。升级、卸载前先结束/暂停录音并完成补传，再退出常驻程序。默认保留会议数据；不附带 Python、FunASR 模型或登录自启。\n\n[FunASR 与模型配置](https://github.com/RoyalLiang/LingJi-Meeting-Studio/blob/${sourceRevision}/docs/engineering/funasr.md)。发布状态以对应 GitHub Release 和回执为准。\n\n${notes}\n`;
 await writeFile(join(stage,'INSTALL-windows-x64.md'),guide);
 await rm(installerSmoke);
 await rename(stage,output);
 console.log(JSON.stringify({output,artifact,sourceRevision,sha256:metadata.sha256,platform:'windows',architecture:'x64'}));
}finally{await rm(stage,{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});}

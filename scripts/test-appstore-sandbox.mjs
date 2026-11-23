import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSandboxBridge,machoFiles,fileDigest} from './macos-appstore.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function testStoreSandbox(resources,output){
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  const runtime=join(root,'.agent-runtime/testflight');await mkdir(runtime,{recursive:true});
  const scratch=await mkdtemp(join(runtime,'probe-')),id=`com.lingji.sandboxprobe.${randomBytes(8).toString('hex')}`,app=join(scratch,'SandboxProbe.app'),contents=join(app,'Contents'),assets=join(contents,'Resources');
  try{
    await mkdir(join(contents,'MacOS'),{recursive:true});await mkdir(assets);
    execFileSync('cp',['-cR',resolve(resources),join(assets,'clone')]);
    await buildSandboxBridge(root,join(assets,'clone/runtime/sandbox-bookmarks.node'));
    await copyFile(join(root,'tests/fixtures/appstore-sandbox-backend.mjs'),join(assets,'backend-probe.mjs'));
    await writeFile(join(assets,'package.json'),'{"private":true,"type":"module"}\n');
    await writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>probe-main</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSBackgroundOnly</key><true/></dict></plist>`);
    execFileSync('xcrun',['clang','-fobjc-arc','-framework','Foundation',join(root,'tests/fixtures/appstore-sandbox-parent.m'),'-o',join(contents,'MacOS/probe-main')]);
    const main=join(scratch,'main.plist');let entitlements=await readFile(join(root,'apps/desktop/src-tauri/Entitlements.appstore.plist'),'utf8');
    entitlements=entitlements.replace(/<key>com\.apple\.application-identifier<\/key><string>[^<]*<\/string>\s*/,'').replace(/<key>com\.apple\.developer\.team-identifier<\/key><string>[^<]*<\/string>\s*/,'');await writeFile(main,entitlements);
    for(const file of await machoFiles(app)){
      if(file.path===join(contents,'MacOS/probe-main'))continue;
      execFileSync('codesign',['--force','--sign','-','--options','0','--timestamp=none',...(file.executable?['--entitlements',join(root,'apps/desktop/src-tauri/Entitlements.helper.plist')]:[]),file.path],{stdio:'pipe'});
    }
    execFileSync('codesign',['--force','--sign','-','--options','0','--timestamp=none','--entitlements',main,app],{stdio:'pipe'});
    execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
    const forbidden=join(scratch,'forbidden.txt'),initial=Buffer.from('sandbox fixture must remain unchanged\n');await writeFile(forbidden,initial);
    const stdout=execFileSync(join(contents,'MacOS/probe-main'),[forbidden],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
    const reports=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}),report=reports.find(value=>value.phase==='backend-node');
    assert.equal(report?.ok,true,'Sandbox backend probe failed');assert.equal(report.bookmarkAddonLoaded,true);assert.equal(report.bootstrapStatus,200);assert.equal(report.sqlitePersistedAfterStop,true);assert.equal(report.sherpaWorker.loaded,true);assert.equal(report.externalConnectionsBlocked,0);assert.ok(['EPERM','EACCES'].includes(report.forbiddenWriteDenied));
    assert.deepEqual(await readFile(forbidden),initial,'Sandbox escaped its container');
    const receipt={...report,sandboxExecution:true,signing:'ad-hoc-preflight',bundleId:id,fixtureSha256:fileDigest(initial),realAudioDevicesOpened:false,realProvidersInvoked:false};
    await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({sandboxExecution:true,sqlite:report.handshake.sqlite,asrWorker:true,containerEscapeDenied:true}));return receipt;
  }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await testStoreSandbox(resolve(process.argv[2]||join(root,'apps/desktop/src-tauri/resources')),resolve(process.argv[3]||join(root,'.agent-runtime/testflight/sandbox-probe.json')));

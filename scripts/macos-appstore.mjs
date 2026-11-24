import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {open,readdir,readFile,mkdir,writeFile,realpath,lstat,chmod} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute} from 'node:path';

export const storeBundleId='com.tts.meeting';
export function storeVersions(product,run,attempt=1){
  assert.match(product,/^\d+\.\d+\.\d+(?:\.\d+)?$/,'Invalid product version');
  // shortcut: use bounded workflow counters; introduce another CFBundleVersion component before run 10000.
  assert.ok(Number.isInteger(Number(run))&&Number(run)>0&&Number(run)<=9999,'App Store build counter must be 1..9999');
  assert.ok(Number.isInteger(Number(attempt))&&Number(attempt)>0&&Number(attempt)<=99,'App Store attempt must be 1..99');
  return {marketingVersion:product.split('.').slice(0,3).join('.'),buildVersion:`${Number(run)}.${Number(attempt)}`};
}
export function validateStoreProfile(profile,{team,bundleId=storeBundleId,now=Date.now()}={}){
  assert.match(team||'',/^[A-Z0-9]{10}$/,'Apple Team ID required');
  assert.ok(profile.teamIdentifiers?.includes(team),'Provisioning profile Team ID mismatch');
  assert.ok(profile.platforms?.includes('OSX'),'A macOS provisioning profile is required');
  assert.ok(Date.parse(profile.expiresAt)>now+3600000,'Provisioning profile expired or expires within one hour');
  assert.ok(!profile.provisionedDevices&&!profile.provisionsAllDevices,'Mac App Store Connect profile required');
  const entitlements=profile.entitlements||{};
  assert.equal(entitlements['com.apple.application-identifier']||entitlements['application-identifier'],`${team}.${bundleId}`,'Profile App ID mismatch');
  assert.ok(!entitlements['get-task-allow']&&!entitlements['com.apple.security.get-task-allow'],'Development profile cannot be uploaded');
  return profile;
}
export function plistJson(bytes){
  return JSON.parse(execFileSync('python3',['-c',
    'import sys,json,plistlib; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'
  ],{input:bytes,maxBuffer:8*1024*1024}));
}
export function readStoreProfile(path){
  const xml=execFileSync('security',['cms','-D','-i',path],{maxBuffer:8*1024*1024});
  return JSON.parse(execFileSync('python3',['-c',
    'import sys,json,plistlib,hashlib; p=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps({"uuid":p.get("UUID"),"teamIdentifiers":p.get("TeamIdentifier"),"platforms":p.get("Platform"),"expiresAt":p["ExpirationDate"].isoformat()+"Z","entitlements":p.get("Entitlements"),"provisionedDevices":p.get("ProvisionedDevices"),"provisionsAllDevices":p.get("ProvisionsAllDevices",False),"certificates":[hashlib.sha256(c).hexdigest() for c in p.get("DeveloperCertificates",[])]}))'
  ],{input:xml,maxBuffer:8*1024*1024}));
}
export async function buildSandboxBridge(root,output){
  assert.equal(process.platform,'darwin');
  await mkdir(dirname(output),{recursive:true});
  const minimum=JSON.parse(await readFile(join(root,'apps/desktop/src-tauri/tauri.conf.json'),'utf8')).bundle.macOS.minimumSystemVersion;
  assert.match(minimum,/^\d+\.\d+(?:\.\d+)?$/);
  execFileSync('xcrun',['clang',`-mmacosx-version-min=${minimum}`,'-fobjc-arc','-bundle','-undefined','dynamic_lookup','-framework','Foundation',join(root,'apps/desktop/src-tauri/native/sandbox-bookmarks.m'),'-o',output],{stdio:'inherit'});
  assert.equal(execFileSync('vtool',['-show-build',output],{encoding:'utf8'}).match(/\bminos\s+(\S+)/)?.[1],minimum,'Sandbox bridge deployment target mismatch');
}
export async function storeBundlePermissions(app,{repair=false}={}){
  async function visit(path){
    const info=await lstat(path);
    if(info.isSymbolicLink())return;
    assert.ok(info.isDirectory()||info.isFile(),`Unsupported bundle entry: ${path}`);
    const mode=info.isDirectory()||(info.mode&0o111)?0o755:0o644;
    if(repair)await chmod(path,mode);
    else assert.equal(info.mode&0o7777,mode,`App Store bundle permissions: ${path}`);
    if(info.isDirectory())for(const name of await readdir(path))await visit(join(path,name));
  }
  await visit(app);
}
export async function machoFiles(root){
  const found=[];
  async function walk(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const path=join(directory,entry.name);
      if(entry.isDirectory())await walk(path);
      else if(entry.isSymbolicLink()){
        const target=relative(await realpath(root),await realpath(path));
        assert.ok(target!=='..'&&!target.startsWith('../')&&!isAbsolute(target),`Bundle symlink escapes app: ${path}`);
      }
      else if(entry.isFile()){
        const file=await open(path,'r');let bytes;
        try{bytes=Buffer.alloc(4);await file.read(bytes,0,4,0);}finally{await file.close();}
        if(['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(bytes.toString('hex'))){
          const kind=execFileSync('file',['-b',path],{encoding:'utf8'});
          if(kind.includes('Mach-O'))found.push({path,executable:kind.includes('executable')});
        }
      }
    }
  }
  await walk(root);return found;
}
function codesignDetails(path){
  // codesign writes its display information to stderr, even on success.
  const script='import subprocess,sys; p=subprocess.run(sys.argv[1:],capture_output=True); sys.stdout.buffer.write(p.stdout+p.stderr);sys.exit(p.returncode)';
  return execFileSync('python3',['-c',script,'codesign','--display','--verbose=4',path],{encoding:'utf8'});
}
export function signatureEntitlements(path){
  return plistJson(execFileSync('codesign',['--display','--entitlements',':-',path],{stdio:['ignore','pipe','pipe']}));
}
export async function signStoreApp(app,{identity,team,mainEntitlements,helperEntitlements,marketingVersion,buildVersion}){
  assert.match(identity,/^(Apple Distribution|3rd Party Mac Developer Application):/,'App Store application certificate required');
  assert.ok(identity.endsWith(`(${team})`),'Application signing identity Team ID mismatch');
  // Apple rejects quarantined macOS bundles; clear derived resource attributes before sealing.
  execFileSync('xattr',['-cr',app]);
  await storeBundlePermissions(app,{repair:true});
  const main=join(app,'Contents/MacOS/tts-client'),files=await machoFiles(app);
  assert.ok(files.some(file=>file.path.endsWith('/runtime/node')),'Bundled Node executable missing');
  assert.ok(files.some(file=>file.path.endsWith('/runtime/sandbox-bookmarks.node')),'Sandbox bridge missing');
  execFileSync('plutil',['-replace','CFBundleShortVersionString','-string',marketingVersion,join(app,'Contents/Info.plist')]);
  execFileSync('plutil',['-replace','CFBundleVersion','-string',buildVersion,join(app,'Contents/Info.plist')]);
  for(const file of files){
    if(file.path===main)continue;
    const args=['--force','--sign',identity,'--options','0','--timestamp'];
    if(file.executable)args.push('--entitlements',helperEntitlements);
    execFileSync('codesign',[...args,file.path],{stdio:'inherit'});
  }
  execFileSync('codesign',['--force','--sign',identity,'--options','0','--timestamp','--entitlements',mainEntitlements,app],{stdio:'inherit'});
  await verifyStoreApp(app,{team,marketingVersion,buildVersion});
}
export async function verifyStoreApp(app,{team,marketingVersion,buildVersion}){
  await storeBundlePermissions(app);
  execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
  const main=signatureEntitlements(app),info=plistJson(await readFile(join(app,'Contents/Info.plist')));
  assert.equal(main['com.apple.security.app-sandbox'],true);
  for(const key of ['network.client','network.server','device.audio-input','files.user-selected.read-write','files.downloads.read-write','files.bookmarks.app-scope'])assert.equal(main[`com.apple.security.${key}`],true,`Missing Store permission: ${key}`);
  assert.equal(main['com.apple.application-identifier'],`${team}.${storeBundleId}`);
  assert.equal(main['com.apple.developer.team-identifier'],team);
  assert.equal(main['com.apple.security.inherit'],undefined);
  assert.equal(main['com.apple.security.get-task-allow'],undefined);
  assert.equal(info.CFBundleIdentifier,storeBundleId);
  assert.equal(info.CFBundleShortVersionString,marketingVersion);
  assert.equal(info.CFBundleVersion,buildVersion);
  assert.doesNotMatch(execFileSync('xattr',['-lr',app],{encoding:'utf8'}),/com\.apple\.quarantine/,'Quarantined App Store bundle');
  for(const file of await machoFiles(app)){
    const details=codesignDetails(file.path);
    assert.ok(details.includes(`TeamIdentifier=${team}`),`Nested code signing team mismatch: ${file.path}`);
    assert.doesNotMatch(details,/flags=.*\bruntime\b/,'Store executables must not retain Node hardened runtime flags');
    if(file.executable&&file.path!==join(app,'Contents/MacOS/tts-client'))assert.deepEqual(signatureEntitlements(file.path),{'com.apple.security.app-sandbox':true,'com.apple.security.inherit':true});
  }
  return {sandbox:true,nestedSignatures:true,marketingVersion,buildVersion};
}
export async function writeStoreEntitlements(root,directory,team){
  assert.match(team,/^[A-Z0-9]{10}$/);
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,'Entitlements.plist');
  const template=await readFile(join(root,'apps/desktop/src-tauri/Entitlements.appstore.plist'),'utf8');
  await writeFile(path,template.replaceAll('__TEAM_ID__',team),{mode:0o600});
  return path;
}
export const fileDigest=bytes=>createHash('sha256').update(bytes).digest('hex');

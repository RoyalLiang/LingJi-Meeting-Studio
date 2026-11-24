import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,access,realpath,chmod,stat,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,verify} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRepository} from '../services/records/src/repository.mjs';
import {installSandboxDirectories,authorizeSandboxDirectory} from '../services/records/src/macos-sandbox.mjs';
import {saveAudioBackupSettings} from '../services/records/src/audio-backup.mjs';
import {storeVersions,validateStoreProfile,buildSandboxBridge,storeBundlePermissions,machoFiles} from '../scripts/macos-appstore.mjs';
import {storeJwt,matchingStoreBuild,validateTestFlightReceipt} from '../scripts/upload-testflight.mjs';

test('Store bundle permissions make private resources readable without following symlinks',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'lingji-store-permissions-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const app=join(root,'LingJi.app'),contents=join(app,'Contents'),profile=join(contents,'embedded.provisionprofile'),executable=join(contents,'node'),outside=join(root,'private.key');
  await mkdir(contents,{recursive:true});
  await writeFile(profile,'public provisioning profile');
  await writeFile(executable,'executable fixture');
  await writeFile(outside,'private signing input');
  for(const path of [app,contents,executable])await chmod(path,0o700);
  for(const path of [profile,outside])await chmod(path,0o600);
  await symlink(outside,join(contents,'escape'));
  await assert.rejects(storeBundlePermissions(app),/App Store bundle permissions/);
  await storeBundlePermissions(app,{repair:true});
  await storeBundlePermissions(app);
  for(const path of [app,contents,executable])assert.equal((await stat(path)).mode&0o7777,0o755);
  assert.equal((await stat(profile)).mode&0o7777,0o644);
  assert.equal(await readFile(profile,'utf8'),'public provisioning profile');
  assert.equal((await stat(outside)).mode&0o7777,0o600);
  await assert.rejects(machoFiles(app),/Bundle symlink escapes app/);
  await chmod(profile,0o600);
  await assert.rejects(storeBundlePermissions(app),/App Store bundle permissions/);
});

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'lingji-appstore-')),repo=await createRepository({root:join(root,'repo'),databaseUrl:''});
  t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
  const destination=join(root,'backup');await mkdir(destination);
  return {root,repo,destination};
}
test('sandbox requires a picker grant before backup settings can write outside the container',async t=>{
  const {repo,destination}=await fixture(t),calls=[];
  const close=await installSandboxDirectories(repo,{resolveBookmarks:json=>{const values=JSON.parse(json);calls.push(values);return JSON.stringify(Object.keys(values).filter(path=>values[path]==='valid'));}});
  t.after(close);
  const setting={enabled:true,directory:destination,retentionDays:0};
  await assert.rejects(saveAudioBackupSettings(repo,'owner',setting),{code:'invalid_audio_backup_directory'});
  await assert.rejects(access(join(destination,'聆记音频备份')),{code:'ENOENT'});
  await writeFile(join(repo.root,'directory-bookmarks.json'),JSON.stringify({[destination]:'valid'}));
  await saveAudioBackupSettings(repo,'owner',setting);
  await access(join(destination,'聆记音频备份'));
  await writeFile(join(repo.root,'directory-bookmarks.json'),'{}');
  await assert.rejects(authorizeSandboxDirectory(repo,destination),{code:'invalid_audio_backup_directory'});
  assert.ok(calls.length>=3);
  await close();assert.deepEqual(calls.at(-1),{});
});
test('bad directory bookmarks do not block startup or erase user backup data',async t=>{
  const {repo,destination}=await fixture(t),file=join(repo.root,'directory-bookmarks.json');
  await writeFile(join(destination,'keep.txt'),'keep');await writeFile(file,'broken');
  const close=await installSandboxDirectories(repo,{resolveBookmarks:json=>JSON.stringify(Object.keys(JSON.parse(json)))});t.after(close);
  await assert.rejects(authorizeSandboxDirectory(repo,destination));
  assert.equal(await readFile(join(destination,'keep.txt'),'utf8'),'keep');
  await writeFile(file,JSON.stringify({[destination]:'restored'}));
  await authorizeSandboxDirectory(repo,destination);
});
test('scope bridge output cannot authorize a path absent from the native handoff',async t=>{
  const {repo,destination}=await fixture(t);
  const close=await installSandboxDirectories(repo,{resolveBookmarks:()=>JSON.stringify([destination])});t.after(close);
  await assert.rejects(authorizeSandboxDirectory(repo,destination),{code:'invalid_audio_backup_directory'});
});
test('standalone backups retain their existing directory behavior',async t=>{
  const {repo,destination}=await fixture(t);const close=await installSandboxDirectories(repo,null);t.after(close);
  await saveAudioBackupSettings(repo,'owner',{enabled:true,directory:destination,retentionDays:0});
  await access(join(destination,'聆记音频备份'));
});
test('Store build numbers fit Apple fields while four-part product versions remain unchanged',()=>{
  assert.deepEqual(storeVersions('0.3.39.12',321,2),{marketingVersion:'0.3.39',buildVersion:'321.2'});
  assert.throws(()=>storeVersions('0.3.39.12',10000),/counter/);
  assert.throws(()=>storeVersions('0.3.39.12',0),/counter/);
  assert.throws(()=>storeVersions('0.3.39.12',1,100),/attempt/);
});
test('Store profile rejects development, expired, other-team and other-App-ID profiles',()=>{
  const team='ABCDE12345',profile={teamIdentifiers:[team],platforms:['OSX'],expiresAt:'2099-01-01T00:00:00Z',entitlements:{'com.apple.application-identifier':`${team}.com.tts.meeting`}};
  assert.equal(validateStoreProfile(profile,{team}),profile);
  for(const invalid of [{...profile,teamIdentifiers:['ZZZZZ12345']},{...profile,expiresAt:'2000-01-01T00:00:00Z'},{...profile,provisionedDevices:['device']},{...profile,provisionsAllDevices:true},{...profile,entitlements:{...profile.entitlements,'get-task-allow':true}},{...profile,entitlements:{...profile.entitlements,'com.apple.application-identifier':`${team}.other`}}])assert.throws(()=>validateStoreProfile(invalid,{team}));
});
test('real native bookmark bridge verifies the resolved directory and rejects malformed input',{skip:process.platform!=='darwin'},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'lingji-bookmark-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=fileURLToPath(new URL('..',import.meta.url)),output=join(root,'sandbox.node'),fixture=join(root,'bookmark');
  await buildSandboxBridge(source,output);
  assert.match(execFileSync('vtool',['-show-build',output],{encoding:'utf8'}),/\bminos\s+14\.6\b/);
  execFileSync('xcrun',['clang','-fobjc-arc','-framework','Foundation',join(source,'tests/fixtures/macos-bookmark.m'),'-o',fixture]);
  const data=execFileSync(fixture,[root],{encoding:'utf8'}).trim(),native=createRequire(import.meta.url)(output);
  assert.deepEqual(JSON.parse(native.resolveBookmarks(JSON.stringify({[root]:data}))),[root]);
  assert.deepEqual(JSON.parse(native.resolveBookmarks(JSON.stringify({[join(root,'wrong')]:data}))),[]);
  assert.throws(()=>native.resolveBookmarks('[]'),/bookmarks/);
  assert.throws(()=>native.resolveBookmarks('x'.repeat(1024*1024+1)),/bookmarks/);
  assert.deepEqual(JSON.parse(native.resolveBookmarks('{}')),[]);
});
test('App Store team JWT is valid ES256 with issuer and bounded lifetime',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),issuer='12345678-1234-1234-1234-123456789abc';
  const token=storeJwt({privateKey:privateKey.export({type:'pkcs8',format:'pem'}),keyId:'ABCDE12345',issuer,now:10000}),[header,payload,signature]=token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iss:issuer,iat:10000,exp:10600,aud:'appstoreconnect-v1'});
  assert.equal(verify('sha256',Buffer.from(`${header}.${payload}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
});
test('Apple processing observation matches platform, marketing version and build together',()=>{
  const build={id:'build',attributes:{version:'12.1'},relationships:{preReleaseVersion:{data:{id:'release'}}}},response={data:[build],included:[{type:'preReleaseVersions',id:'release',attributes:{version:'0.3.39',platform:'MAC_OS'}}]},versions={marketingVersion:'0.3.39',buildVersion:'12.1'};
  assert.equal(matchingStoreBuild(response,versions),build);
  assert.equal(matchingStoreBuild(response,{...versions,buildVersion:'13.1'}),undefined);
  response.included[0].attributes.platform='IOS';assert.equal(matchingStoreBuild(response,versions),undefined);
});
test('upload refuses a different source/controller or a package path outside its artifact',()=>{
  const expected={sourceSha:'a'.repeat(40),controllerSha:'b'.repeat(40)},receipt={schema:'lingji-testflight-package/v1',...expected,bundleId:'com.tts.meeting',sandbox:true,nestedSignatures:true,file:{name:'Lingji-0.3.39.0.pkg'}};
  assert.equal(validateTestFlightReceipt(receipt,expected),receipt);
  for(const invalid of [{...receipt,sourceSha:'c'.repeat(40)},{...receipt,controllerSha:'c'.repeat(40)},{...receipt,file:{name:'../outside.pkg'}},{...receipt,sandbox:false}])assert.throws(()=>validateTestFlightReceipt(invalid,expected));
});

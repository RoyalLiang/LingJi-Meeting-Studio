import test from 'node:test';
import assert from 'node:assert/strict';
import {msixManifest, msixVersion, storeIdentity, fixedRuntimeManifest, writeStoreIcons, installStoreResources, storeResourceOutputs, restoreStoreResources} from '../scripts/windows-msix.mjs';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const env = {storeId: '9TESTMSIX001', name: '12345.LingJi', publisher: 'CN=12345678-1234-1234-1234-123456789abc', displayName: '聆记 & "个人"', appDisplayName: '聆记 LingJi'};

test('Fixed runtime manifest includes complete relative paths, hashes and empty hidden files',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingji-runtime-manifest-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'EBWebView/x64'),{recursive:true});
  for(const name of ['msedgewebview2.exe','msedge.dll','EBWebView/x64/EmbeddedBrowserWebView.dll']) await writeFile(join(directory,name),name);
  await writeFile(join(directory,'.empty'),'');
  const manifest=await fixedRuntimeManifest(directory,'157.0.4341.60');
  assert.equal(manifest.version,'157.0.4341.60');assert.equal(manifest.files.length,4);
  assert.deepEqual(manifest.files.find(f=>f.path==='.empty'),{path:'.empty',size:0,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});
  const name='EBWebView/x64/EmbeddedBrowserWebView.dll';
  assert.deepEqual(manifest.files.find(f=>f.path===name),{path:name,size:Buffer.byteLength(name),sha256:createHash('sha256').update(name).digest('hex')});
  await assert.rejects(fixedRuntimeManifest(directory,'../runtime'));
  await rm(join(directory,'msedge.dll'));await assert.rejects(fixedRuntimeManifest(directory,'157.0.4341.60'),/Incomplete/);
});

test('Fixed runtime manifest refuses redirected payloads',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingji-runtime-link-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'original'),'bytes');
  try { await symlink(join(directory,'original'),join(directory,'redirected')); } catch(error) { if(error.code==='EPERM'&&process.platform==='win32'){t.skip('Windows symlink privilege unavailable');return;}throw error; }
  await assert.rejects(fixedRuntimeManifest(directory,'157.0.4341.60'),/regular files/);
});

test('Store identity must be reserved and complete rather than guessed from the application name', () => {
  assert.throws(() => storeIdentity({}));
  const identity = storeIdentity(env);
  assert.equal(identity.name, env.name);
  assert.equal(identity.publisher, env.publisher);
  for (const key of Object.keys(env)) assert.throws(() => storeIdentity({...env, [key]: ''}));
  for (const name of ['../Lingji', 'a', 'app/name', 'app name', 'a'.repeat(51)]) assert.throws(() => storeIdentity({...env, name}));
  for (const publisher of ['Royal', 'CN=<injected>', 'CN=name\nPublisher=other']) assert.throws(() => storeIdentity({...env, publisher}));
});

test('MSIX maps zero-major product releases monotonically to valid Store versions with a zero fourth part', () => {
  assert.equal(msixVersion('0.3.30'), '1.3.30.0');
  assert.equal(msixVersion('0.3.34.1'),'1.3.3401.0');
  assert.equal(msixVersion('0.3.3401'),'1.3.3401.0');
  assert.equal(msixVersion('1.0.0'), '2.0.0.0');
  assert.equal(msixVersion('65534.65535.65535'), '65535.65535.65535.0');
  for (const version of ['65535.0.0', 'v0.3.30', '0.03.30', '1.2.65536', '../1.2', '1.2']) assert.throws(() => msixVersion(version));
});

test('Store manifest runs the existing desktop executable with explicit capabilities and escaped publisher text', () => {
  const manifest = msixManifest('0.3.30', storeIdentity(env));
  assert.ok(manifest.includes(`Name="${env.name}" Publisher="${env.publisher}" Version="1.3.30.0"`));
  assert.ok(manifest.includes('Executable="tts-client.exe" EntryPoint="Windows.FullTrustApplication"'));
  assert.ok(manifest.includes('<PublisherDisplayName>聆记 &amp; &quot;个人&quot;</PublisherDisplayName>'));
  assert.match(manifest, /Name="runFullTrust"/);
  assert.match(manifest, /Name="microphone"/);
  assert.match(manifest, /MinVersion="10\.0\.19041\.0"/);
  assert.doesNotMatch(manifest, /setup\.exe|broadFileSystemAccess|AppxSignature/);
});

test('MSIX builds alpha PNGs and unplated light/dark resources for taskbar sizes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingji-store-icons-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=fileURLToPath(new URL('../',import.meta.url)), resources=join(directory,'fresh-store-output'), assets=join(resources,'Assets');
  await writeStoreIcons(root,assets);
  for(const [name,size] of [['StoreLogo',50],['Square150x150Logo.scale-200',300],['Square44x44Logo',44],['Square44x44Logo.targetsize-24_altform-unplated',24],['Square44x44Logo.targetsize-24_altform-lightunplated',24],['Square44x44Logo.targetsize-96_altform-unplated',96]]){
    const png=await readFile(join(assets,name+'.png'));
    assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20),png[25]],[size,size,6],name);
  }
  const sourceRevision='a'.repeat(40);
  await writeFile(join(resources,'resources.pri'),'synthetic resource index');
  const {readdir}=await import('node:fs/promises');
  const names=['resources.pri',...(await readdir(assets)).map(name=>'Assets/'+name)];
  const files=await Promise.all(names.map(async name=>({name,sha256:createHash('sha256').update(await readFile(join(resources,name))).digest('hex')})));
  await writeFile(join(resources,'store-icons.json'),JSON.stringify({sourceRevision,files}));
  const output=await storeResourceOutputs(resources);
  assert.ok(output.parts.filter(Boolean).length > 1,'Real icon assets exercise chunked job output');
  const restored=join(directory,'restored');
  await assert.rejects(restoreStoreResources(restored,{...output,parts:['',...output.parts.slice(1)]},sourceRevision),/output hash differs/);
  await assert.rejects(restoreStoreResources(restored,output,'b'.repeat(40)),/release source/);
  await restoreStoreResources(restored,output,sourceRevision);
  await installStoreResources(restored,join(directory,'payload'),sourceRevision);
  await assert.rejects(installStoreResources(resources,join(directory,'other'),'b'.repeat(40)),/release source/);
  await writeFile(join(resources,'resources.pri'),'changed resource index');
  await assert.rejects(installStoreResources(resources,join(directory,'other'),sourceRevision),/hash differs/);
});

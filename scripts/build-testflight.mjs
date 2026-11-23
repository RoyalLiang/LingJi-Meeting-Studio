import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,symlink,rm,access,copyFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {snapshotReleaseSource,restoreTauriCargoManifest} from './release-source.mjs';
import {storeVersions,readStoreProfile,validateStoreProfile,buildSandboxBridge,writeStoreEntitlements,signStoreApp,fileDigest,storeBundleId} from './macos-appstore.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const required=name=>{assert.ok(process.env[name],`${name} required`);return process.env[name];};
function run(program,args,options={}){execFileSync(program,args,{cwd:root,stdio:'inherit',...options});}
export async function buildTestFlight(){
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  const source=required('TTS_RELEASE_SOURCE_REF'),team=required('APPLE_TEAM_ID'),identity=required('APPLE_APP_STORE_IDENTITY'),installer=required('APPLE_INSTALLER_IDENTITY'),profilePath=required('APPLE_TESTFLIGHT_PROFILE_PATH');
  assert.match(source,/^[a-f0-9]{40}$/);assert.match(installer,/^3rd Party Mac Developer Installer:/);assert.ok(installer.endsWith(`(${team})`));
  const profile=validateStoreProfile(readStoreProfile(profilePath),{team});
  const certificate=new X509Certificate(execFileSync('security',['find-certificate','-c',identity,'-p']));
  assert.ok(profile.certificates.includes(certificate.fingerprint256.replaceAll(':','').toLowerCase()),'Profile does not include selected distribution certificate');
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')),productVersion=manifest.releaseVersion;
  const versions=storeVersions(productVersion,required('GITHUB_RUN_NUMBER'),process.env.GITHUB_RUN_ATTEMPT||1);
  const runtime=join(root,'.agent-runtime/testflight');await mkdir(runtime,{recursive:true});
  const scratch=await mkdtemp(join(runtime,'build-')),frozen=join(scratch,'source');
  try{
    const sourceSnapshot=await snapshotReleaseSource({root,ref:source,destination:frozen});
    const cargoPath=join(frozen,'apps/desktop/src-tauri/Cargo.toml'),cargoInput=await readFile(cargoPath,'utf8');
    for(const workspace of ['','apps/web','apps/desktop']){
      const modules=join(root,workspace,'node_modules');try{await access(modules);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      await symlink(modules,join(frozen,workspace,'node_modules'));
    }
    const {prepareClientBackend}=await import(pathToFileURL(join(frozen,'scripts/prepare-client-backend.mjs')).href);
    await prepareClientBackend({root:frozen,cacheRoot:join(root,'.agent-runtime/runtimes')});
    await buildSandboxBridge(frozen,join(frozen,'apps/desktop/src-tauri/resources/runtime/sandbox-bookmarks.node'));
    run('npm',['run','build:web'],{cwd:frozen});
    const mainEntitlements=await writeStoreEntitlements(frozen,scratch,team);
    const config=JSON.parse(await readFile(join(frozen,'apps/desktop/src-tauri/tauri.appstore.conf.json'),'utf8'));
    Object.assign(config.bundle.macOS,{entitlements:mainEntitlements,signingIdentity:identity,bundleVersion:versions.buildVersion,files:{'embedded.provisionprofile':profilePath}});
    const configPath=join(scratch,'tauri.appstore.conf.json');await writeFile(configPath,JSON.stringify(config));
    const target=join(runtime,'target');
    run('npm',['exec','--workspace','apps/desktop','--','tauri','build','--ci','--bundles','app','--features','app-store','--config',configPath,'--','--locked'],{cwd:frozen,env:{...process.env,CARGO_TARGET_DIR:target,APPLE_SIGNING_IDENTITY:identity}});
    await restoreTauriCargoManifest(cargoPath,cargoInput);
    const base=JSON.parse(await readFile(join(frozen,'apps/desktop/src-tauri/tauri.conf.json'),'utf8'));
    const app=join(target,'release/bundle/macos',`${base.productName}.app`);
    await signStoreApp(app,{identity,team,mainEntitlements,helperEntitlements:join(frozen,'apps/desktop/src-tauri/Entitlements.helper.plist'),...versions});
    for(const file of sourceSnapshot.files)if(file.sha256)assert.equal(fileDigest(await readFile(join(frozen,file.path))),file.sha256,`Frozen source changed during build: ${file.path}`);
    const embedded=readStoreProfile(join(app,'Contents/embedded.provisionprofile'));assert.equal(embedded.uuid,profile.uuid);
    const output=join(root,'testflight-artifacts');await mkdir(output,{recursive:true});
    const name=`Lingji-${productVersion}-${versions.buildVersion}-macos-arm64.pkg`,pkg=join(output,name);
    run('xcrun',['productbuild','--sign',installer,'--timestamp','--component',app,'/Applications',pkg]);
    const signature=execFileSync('pkgutil',['--check-signature',pkg],{encoding:'utf8'});assert.ok(signature.includes(`(${team})`),'Installer signing team mismatch');
    const bytes=await readFile(pkg),controller=required('WORKFLOW_SHA');assert.match(controller,/^[a-f0-9]{40}$/);
    const toolchain={xcode:execFileSync('xcodebuild',['-version'],{encoding:'utf8'}).trim(),macosSdk:execFileSync('xcrun',['--sdk','macosx','--show-sdk-version'],{encoding:'utf8'}).trim()};
    const receipt={schema:'lingji-testflight-package/v1',sourceSha:source,controllerSha:controller,sourceSha256:sourceSnapshot.sha256,productVersion,bundleId:storeBundleId,team,...versions,profileUuid:profile.uuid,sandbox:true,nestedSignatures:true,quarantineCleared:true,toolchain,file:{name,bytes:bytes.length,sha256:fileDigest(bytes)}};
    await writeFile(join(output,'testflight-package.json'),JSON.stringify(receipt,null,2)+'\n');
    await copyFile(mainEntitlements,join(output,'Entitlements.plist'));
    console.log(JSON.stringify({sourceSha:source,productVersion,...versions,file:receipt.file}));return receipt;
  }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildTestFlight();

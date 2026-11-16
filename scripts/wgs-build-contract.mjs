import assert from 'node:assert/strict';
import {readFile,writeFile,access,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {snapshotReleaseSource} from './release-source.mjs';

async function measuredFile(path){
 const info=await lstat(path);assert.ok(info.isFile()&&info.size>0,'Build output must be a nonempty regular file');
 const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return {size:info.size,sha256:hash.digest('hex')};
}

export async function assertCurrentSource(root,revision){
 const expected=await snapshotReleaseSource({root,ref:revision}),actual=await snapshotReleaseSource({root});
 assert.equal(actual.sha256,expected.sha256,'Current WGS source differs from the requested commit');
 return expected;
}
export async function finishCurrentBuild(root,revision,cargoInput){
 const path=join(root,'apps/desktop/src-tauri/Cargo.toml'),actual=await readFile(path,'utf8');
 assert.ok(actual===cargoInput||actual===cargoInput.replaceAll('features = ["tray-icon"]','features = ["macos-private-api", "tray-icon"]'),'Unexpected Cargo manifest change');
 if(actual!==cargoInput)await writeFile(path,cargoInput);
 return assertCurrentSource(root,revision);
}
export async function verifyWgsInput(directory,{version,sourceRevision,source}){
 const receipt=JSON.parse(await readFile(join(directory,'wgs-windows-input.json'),'utf8'));
 assert.equal(receipt.version,version);assert.equal(receipt.sourceRevision,sourceRevision);assert.deepEqual(receipt.source,source);
 assert.equal(receipt.builder,'wgs');assert.equal(receipt.sourceBuildMode,'guarded-current-directory');assert.equal(receipt.sourceVerifiedAfterBuild,true);
 assert.equal(receipt.target,'x86_64-pc-windows-msvc');
 assert.ok([3,4,6].includes(receipt.files.length));assert.equal(new Set(receipt.files.map(file=>file.name)).size,receipt.files.length);
  for(const name of ['windows-setup.exe','resources.tar.gz','lingji-ui-tests.exe'])assert.ok(receipt.files.some(file=>file.name===name));
 if(receipt.files.some(file=>file.name==='store-package.json'||file.name==='windows-store-unsigned.msix')) for(const name of ['store-package.json','windows-store-unsigned.msix','windows-app.exe']) assert.ok(receipt.files.some(file=>file.name===name));
  for(const file of receipt.files){assert.ok(['windows-setup.exe','windows-app.exe','resources.tar.gz','lingji-ui-tests.exe','windows-store-unsigned.msix','store-package.json'].includes(file.name));const actual=await measuredFile(join(directory,file.name));assert.equal(actual.size,file.bytes);assert.equal(actual.sha256,file.sha256);}
 return receipt;
}

export async function reusableWgsBuild(root,expected){
 const linux=join(root,'dist/releases',expected.version,'linux-x64'),windows=join(root,'dist/wgs-input',expected.version);
 const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code!=='ENOENT')throw error;return false;}};
 const present=await Promise.all([exists(linux),exists(windows)]);
 if(present.every(value=>!value))return null;
 assert.ok(present.every(Boolean),'Preserve incomplete WGS outputs; do not overwrite either platform');
 const inputs=await verifyWgsInput(windows,expected);
 assert.equal(inputs.files.length,6,'Reuse requires the complete Store-enabled Windows build');
 const metadata=JSON.parse(await readFile(join(linux,'release-linux-x64.json'),'utf8'));
 assert.equal(metadata.version,expected.version);assert.equal(metadata.sourceRevision,expected.sourceRevision);assert.deepEqual(metadata.source,expected.source);
 assert.equal(metadata.sourceDirty,false);assertPackageSourceBuild(metadata);
 assert.equal(metadata.frozenSourceBuild,false);
 assert.equal(metadata.platform,'linux');assert.equal(metadata.architecture,'x64');
 for(const key of ['debVerified','installedAppProbe','resourcesVerified','uninstallVerified','productionSmoke','bundledAsrTested'])assert.equal(metadata.validation?.[key],true);
 assert.equal(metadata.bundledAsr?.nativeInference,true);
 assert.equal(metadata.artifact,`Lingji-${expected.version}-linux-amd64.deb`);
 const artifact=await measuredFile(join(linux,metadata.artifact));assert.equal(artifact.sha256,metadata.sha256);
 assert.equal((await readFile(join(linux,'SHA256SUMS-linux-x64.txt'),'utf8')).trim(),`${artifact.sha256}  ${metadata.artifact}`);
 const buildCi=metadata.buildCi||metadata.ci;
 assert.equal(buildCi?.repository,expected.repository);assert.equal(buildCi.sourceRevision,expected.sourceRevision);assert.match(String(buildCi.runId),/^\d+$/);
 assert.match(buildCi.workflowSha,/^[a-f0-9]{40}$/);assert.equal(buildCi.runUrl,`https://github.com/${expected.repository}/actions/runs/${buildCi.runId}`);
 const smoke=JSON.parse(await readFile(join(linux,'package-smoke-linux-x64.json'),'utf8'));
 for(const key of ['packagedApp','independentBackend','agentRuntimeReady','bundledAsrConfigured','restartPersistence','stableWebviewProfile','parentOwnsBackend','localAccount','devAccountDisabled'])assert.equal(smoke[key],true);
 assert.equal(smoke.developerBackendRequests,0);
 return {linux,windows,version:expected.version,sourceRevision:expected.sourceRevision,sourceDigest:expected.source.sha256,buildCi,linuxArtifact:{name:metadata.artifact,...artifact},windowsInputs:inputs.files};
}

export function assertPackageSourceBuild(metadata){
 if(metadata.frozenSourceBuild===true)return;
 assert.equal(metadata.frozenSourceBuild,false);
 assert.equal(metadata.sourceBuildMode,'guarded-current-directory');assert.equal(metadata.builder,'wgs');assert.equal(metadata.sourceVerifiedAfterBuild,true);
}

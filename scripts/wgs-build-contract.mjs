import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {snapshotReleaseSource,releaseHash} from './release-source.mjs';

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
 assert.equal(receipt.files.length,3);assert.equal(new Set(receipt.files.map(file=>file.name)).size,3);
 for(const file of receipt.files){assert.ok(['windows-setup.exe','resources.tar.gz','lingji-ui-tests.exe'].includes(file.name));const bytes=await readFile(join(directory,file.name));assert.equal(bytes.length,file.bytes);assert.equal(releaseHash(bytes),file.sha256);}
 return receipt;
}

export function assertPackageSourceBuild(metadata){
 if(metadata.frozenSourceBuild===true)return;
 assert.equal(metadata.frozenSourceBuild,false);
 assert.equal(metadata.sourceBuildMode,'guarded-current-directory');assert.equal(metadata.builder,'wgs');assert.equal(metadata.sourceVerifiedAfterBuild,true);
}

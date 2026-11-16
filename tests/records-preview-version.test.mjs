import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeVersion,versionParts,previewReleaseConfig} from '../scripts/preview-version.mjs';
import {msixVersion} from '../scripts/windows-msix.mjs';

test('four-part repair versions remain monotonic across native and Store packaging',()=>{
  for(const [product,native,store] of [['0.3.34','0.3.34','1.3.34.0'],['0.3.34.0','0.3.3400','1.3.3400.0'],['0.3.34.9','0.3.3409','1.3.3409.0'],['0.3.34.10','0.3.3410','1.3.3410.0'],['0.3.35.0','0.3.3500','1.3.3500.0']]){
    assert.equal(nativeVersion(product),native);assert.equal(msixVersion(product),store);assert.equal(msixVersion(native),store);
    assert.equal(previewReleaseConfig({version:native},{releaseVersion:product}).version,product);
  }
  for(const version of ['0.3.34.100','0.3.656.0','0.03.34.1','0.3.34.-1','0.3.34.1.2'])assert.throws(()=>nativeVersion(version));
  assert.throws(()=>previewReleaseConfig({version:'0.3.34'},{releaseVersion:'0.3.34.1'}));
  assert.deepEqual(versionParts('0.3.34.1'),[0,3,34,1]);
});

test('checked-in product version agrees with package tools and native embedded display',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
  const embedded=(await readFile(new URL('../apps/desktop/src-tauri/product-version.txt',import.meta.url),'utf8')).trim();
  assert.equal(embedded,manifest.releaseVersion);assert.equal(nativeVersion(embedded),manifest.version);
  const tauri=JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.preview.conf.json',import.meta.url)));assert.equal(tauri.version,manifest.version);
});

test('publication requires a successful candidate for the exact source and controller',async()=>{
  const {successfulCandidate,verifyPreviewCandidate}=await import('../scripts/preview-release-gate.mjs');
  const options={repository:'owner/repo',tag:'v0.3.34',sourceRevision:'a'.repeat(40),workflowRevision:'b'.repeat(40),runId:20};
  const run={id:19,event:'workflow_dispatch',conclusion:'success',head_sha:options.workflowRevision,display_title:`Candidate ${options.tag} · ${options.sourceRevision}`};
  assert.equal(successfulCandidate([run],options),run);
  for(const patch of [{id:20},{conclusion:'failure'},{head_sha:'c'.repeat(40)},{display_title:'Preview v0.3.34'},{event:'push'}])assert.equal(successfulCandidate([{...run,...patch}],options),undefined);
  await assert.rejects(verifyPreviewCandidate({...options,request:async()=>({ok:true,json:async()=>({workflow_runs:[]})})}),/No successful candidate/);
  assert.equal((await verifyPreviewCandidate({...options,request:async()=>({ok:true,json:async()=>({workflow_runs:[run]})})})).id,19);
});


test('main source pushes validate candidates but cannot publish directly',async()=>{
  const {assertReleaseEvent}=await import('../scripts/publish-preview-release.mjs');
  const event={eventName:'push',ref:'refs/heads/main',tag:'v0.3.34',commit:'a'.repeat(40),workflowSha:'a'.repeat(40)};
  assert.throws(()=>assertReleaseEvent(event));assertReleaseEvent({...event,candidateOnly:true});
  const {successfulCandidate}=await import('../scripts/preview-release-gate.mjs');
  const run={id:1,event:'push',head_branch:'main',head_sha:event.commit,conclusion:'success',display_title:`Candidate main · ${event.commit}`};
  assert.equal(successfulCandidate([run],{tag:event.tag,sourceRevision:event.commit,workflowRevision:event.commit,runId:2}),run);
  assert.equal(successfulCandidate([{...run,head_branch:'dev'}],{tag:event.tag,sourceRevision:event.commit,workflowRevision:event.commit,runId:2}),undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {signingStatus} from '../scripts/signing-status.mjs';
test('ad-hoc identities and configured secrets never imply trusted signed artifacts',()=>{
  const result=signingStatus({identities:'0 valid identities found',env:{APPLE_SIGNING_IDENTITY:'-',APPLE_API_KEY:'SECRET-DO-NOT-PRINT',TTS_WINDOWS_SIGNING_PROVIDER:'esigner'}});
  assert.equal(result.macOS.identitySelected,false);assert.equal(result.macOS.developerIdCount,0);assert.equal(result.trustedArtifactVerified,false);assert.ok(result.windows.missing.length);assert.doesNotMatch(JSON.stringify(result),/SECRET-DO-NOT-PRINT/);
});
test('a real selected identity and notary configuration are still only preflight evidence',()=>{
  const identity='Developer ID Application: Example (ABCDE12345)',result=signingStatus({identities:`1) 0000 "${identity}"`,env:{APPLE_SIGNING_IDENTITY:identity,TTS_NOTARY_PROFILE:'local-profile'},tools:{gpg:true}});
  assert.equal(result.macOS.developerIdCount,1);assert.equal(result.macOS.identitySelected,true);assert.equal(result.macOS.notarizationConfigured,true);assert.deepEqual(result.macOS.missing,[]);assert.equal(result.trustedArtifactVerified,false);
});

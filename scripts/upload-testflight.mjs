import assert from 'node:assert/strict';
import {createPrivateKey,sign} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {dirname,join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {storeBundleId,fileDigest} from './macos-appstore.mjs';

export function storeJwt({privateKey,keyId,issuer,now=Math.floor(Date.now()/1000)}){
  assert.match(keyId,/^[A-Z0-9]{10}$/);assert.match(issuer,/^[a-f0-9-]{36}$/i);
  const header=Buffer.from(JSON.stringify({alg:'ES256',kid:keyId,typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:issuer,iat:now,exp:now+600,aud:'appstoreconnect-v1'})).toString('base64url');
  const key=createPrivateKey(privateKey);assert.equal(key.asymmetricKeyType,'ec');assert.equal(key.asymmetricKeyDetails.namedCurve,'prime256v1');
  return `${header}.${payload}.${sign('sha256',Buffer.from(`${header}.${payload}`),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
}
export function matchingStoreBuild(response,{marketingVersion,buildVersion}){
  const builds=(response.data||[]).filter(build=>{
    const release=response.included?.find(value=>value.type==='preReleaseVersions'&&value.id===build.relationships?.preReleaseVersion?.data?.id);
    return build.attributes?.version===buildVersion&&release?.attributes?.version===marketingVersion&&release.attributes.platform==='MAC_OS';
  });
  assert.ok(builds.length<=1,'Ambiguous App Store build');return builds[0];
}
export function validateTestFlightReceipt(receipt,{sourceSha,controllerSha}){
  assert.equal(receipt.schema,'lingji-testflight-package/v1');assert.equal(receipt.sourceSha,sourceSha);assert.equal(receipt.controllerSha,controllerSha);
  assert.equal(receipt.bundleId,storeBundleId);assert.equal(receipt.sandbox,true);assert.equal(receipt.nestedSignatures,true);
  assert.equal(basename(receipt.file.name),receipt.file.name);assert.match(receipt.file.name,/^[A-Za-z0-9._-]+\.pkg$/);
  return receipt;
}
export async function uploadTestFlight(directory){
  assert.equal(process.platform,'darwin');
  const receipt=JSON.parse(await readFile(join(directory,'testflight-package.json'),'utf8'));
  validateTestFlightReceipt(receipt,{sourceSha:process.env.SOURCE_SHA,controllerSha:process.env.WORKFLOW_SHA});
  const pkg=join(directory,receipt.file.name),bytes=await readFile(pkg);assert.equal(bytes.length,receipt.file.bytes);assert.equal(fileDigest(bytes),receipt.file.sha256);
  const keyId=process.env.APPLE_API_KEY_ID,issuer=process.env.APPLE_API_ISSUER,privateKey=process.env.APPLE_API_PRIVATE_KEY;
  assert.ok(keyId&&issuer&&privateKey,'App Store Connect team API key required');
  const request=async path=>{
    const result=await fetch(`https://api.appstoreconnect.apple.com${path}`,{headers:{Authorization:`Bearer ${storeJwt({privateKey,keyId,issuer})}`},signal:AbortSignal.timeout(30000)});
    assert.ok(result.ok,`App Store Connect API returned HTTP ${result.status}`);return result.json();
  };
  const apps=await request(`/v1/apps?${new URLSearchParams({'filter[bundleId]':storeBundleId})}`);
  assert.equal(apps.data?.length,1,'Matching App Store Connect app record required');const appId=apps.data[0].id;
  if(process.env.APPLE_APP_ID)assert.equal(appId,process.env.APPLE_APP_ID,'App Store Connect app ID mismatch');
  const builds=()=>request(`/v1/builds?${new URLSearchParams({'filter[app]':appId,'filter[version]':receipt.buildVersion,include:'preReleaseVersion'})}`);
  let build=matchingStoreBuild(await builds(),receipt);
  if(!build){
    const scratch=await mkdtemp(join(process.env.RUNNER_TEMP||dirname(directory),'lingji-upload-'));
    try{
      const keys=join(scratch,'private_keys');await mkdir(keys,{mode:0o700});await writeFile(join(keys,`AuthKey_${keyId}.p8`),privateKey,{mode:0o600});
      const uploaded=spawnSync('xcrun',['altool','--upload-app','--type','macos','--file',pkg,'--apiKey',keyId,'--apiIssuer',issuer,'--output-format','json'],{cwd:scratch,encoding:'utf8',timeout:1200000,maxBuffer:4*1024*1024});
      if(uploaded.status!==0){
        let errors=[];try{errors=JSON.parse(uploaded.stdout)['product-errors']?.map(error=>({code:error.code,message:error.message}))||[];}catch{/* altool can fail before returning JSON. */}
        await writeFile(join(directory,'testflight-upload-error.json'),JSON.stringify({stage:'altool',status:uploaded.status,errors},null,2));
        throw new Error('TestFlight upload failed; see sanitized upload diagnostic');
      }
      console.log('Uploaded signed package; waiting for Apple processing');
    }finally{await rm(scratch,{recursive:true,force:true});}
  }
  const deadline=Date.now()+30*60000;let previous;
  while(Date.now()<deadline){
    build=matchingStoreBuild(await builds(),receipt);
    const state=build?.attributes?.processingState||'WAITING';if(state!==previous){console.log(JSON.stringify({buildId:build?.id,processingState:state}));previous=state;}
    assert.ok(!['FAILED','INVALID'].includes(state),'Apple rejected build processing; review the App Store Connect diagnostic');
    if(state==='VALID'){
      assert.equal(build.attributes.expired,false,'Processed TestFlight build is expired');
      const result={...receipt,appId,buildId:build.id,processingState:state,testflightUrl:`https://appstoreconnect.apple.com/apps/${appId}/testflight`};
      await writeFile(join(directory,'testflight-publication.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({appId,buildId:build.id,processingState:state}));return result;
    }
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
  throw new Error('Apple build processing is still pending; inspect its state before retrying upload');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await uploadTestFlight(resolve(process.argv[2]||'testflight-artifacts'));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

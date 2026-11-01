import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {FEISHU_REDIRECT_URI} from '../packages/records/src/feishu-oauth.mjs';
export async function verifyFeishuRelay(origin,{fetcher=fetch,sourceSha}={}){
  const state=randomBytes(32).toString('base64url'),claim=randomBytes(32).toString('base64url'),challenge=randomBytes(32).toString('base64url'),hash=value=>createHash('sha256').update(value).digest('hex');
  const base=origin+'/api/integrations/feishu',path=base+'/transactions/'+hash(state),code='synthetic-transport-check-'+randomBytes(12).toString('hex');
  const call=(url,method='GET',body,key)=>fetcher(url,{method,redirect:'error',headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{Authorization:`Bearer ${key}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  const configuration=await call(base+'/config');assert.equal(configuration.status,200);const config=await configuration.json();assert.equal(config.redirectUri,FEISHU_REDIRECT_URI);if(sourceSha)assert.equal(config.revision,sourceSha);
  assert.equal((await call(origin+'/api/integrations/feishu/callback')).status,200);
  let started=false;
  try{
    const start=await call(base+'/transactions','POST',{state,challenge,clientId:'cli_transport_check',claimHash:hash(claim)});assert.equal(start.status,201);started=true;
    assert.equal((await (await call(path,'GET',undefined,claim)).json()).status,'pending');
    assert.equal((await call(path,'GET',undefined,state)).status,401);
    const callback=await call(origin+`/api/integrations/feishu/callback?state=${state}&code=${code}`);assert.equal(callback.status,200);assert.equal(callback.headers.get('cache-control'),'no-store');
    const html=await callback.text();assert.ok(!html.includes(code)&&!html.includes(state));
    for(let i=0;i<2;i++)assert.equal((await (await call(path,'GET',undefined,claim)).json()).code,code);
    assert.equal((await call(origin+`/api/integrations/feishu/callback?state=${state}&code=replacement`)).status,410);
    assert.equal((await call(path,'DELETE',undefined,claim)).status,200);assert.equal((await call(path,'GET',undefined,claim)).status,410);
    return {observedAtUtc:new Date().toISOString(),origin,sourceSha:config.revision,redirectUri:config.redirectUri,https:true,configuration:true,landing:true,registration:true,claimIsolation:true,callback:true,retrySameDevice:true,replayRejected:true,retirement:true,realFeishuAuthorization:false,meetingContentSent:false};
  }finally{if(started)await call(path,'DELETE',undefined,claim).catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const result=await verifyFeishuRelay(process.argv[2]||'https://auth.rookiecode.com');if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}

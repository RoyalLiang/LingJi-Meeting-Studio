import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DomainError} from '../../../../packages/records/src/record.mjs';
import {FEISHU_RELAY_ORIGIN,FEISHU_REDIRECT_URI} from '../../../../packages/records/src/feishu-oauth.mjs';

const base=FEISHU_RELAY_ORIGIN+'/api/integrations/feishu/transactions';
export async function openFeishuRelay({state,challenge,clientId,signal,fetcher=fetch,now=Date.now,pollMs=1500}){
  const claim=randomBytes(32).toString('base64url'),hash=value=>createHash('sha256').update(value).digest('hex'),id=hash(state);
  async function request(url,method='GET',body,closing=false){
    try{
      const response=await fetcher(url,{method,redirect:'error',headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='POST'?{Authorization:`Bearer ${claim}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:closing?AbortSignal.timeout(3000):AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      const text=await response.text();if(text.length>8000)throw new Error('oversized');const value=JSON.parse(text);
      if(!response.ok)throw new DomainError(response.status===410?'feishu_oauth_expired':response.status===429?'feishu_relay_rate_limited':'feishu_relay_unavailable',response.status===410?409:503);
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid');return value;
    }catch(error){if(signal.aborted&&!closing)throw signal.reason;if(error instanceof DomainError)throw error;throw new DomainError('feishu_relay_unavailable',503);}
  }
  const registration={state,challenge,clientId,claimHash:hash(claim)};
  let value;
  for(let attempt=0;attempt<2;attempt++){try{value=await request(base,'POST',registration);break;}catch(error){if(signal.aborted||error.code!=='feishu_relay_unavailable'||attempt===1)throw error;await delay(300,undefined,{signal});}}
  if(value.id!==id||value.redirectUri!==FEISHU_REDIRECT_URI||!Number.isFinite(value.expiresAt)||value.expiresAt<=now())throw new DomainError('feishu_relay_unavailable',503);
  const expiresAt=Math.min(now()+600000,value.expiresAt);let closed;
  return {expiresAt,close(){return closed??=request(`${base}/${id}`,'DELETE',undefined,true).catch(()=>{});},async wait(){
    let failures=0;
    while(now()<expiresAt){
      let result;
      try{result=await request(`${base}/${id}`);failures=0;}catch(error){if(signal.aborted||error.code!=='feishu_relay_unavailable'||++failures>=3)throw error;}
      if(result?.status==='ready'){
        if(result.error==='access_denied')throw new DomainError('feishu_authorization_denied',400);
        if(typeof result.code!=='string'||!result.code||result.code.length>4096||result.error)throw new DomainError('feishu_oauth_invalid',400);
        return result.code;
      }
      if(result&&result.status!=='pending')throw new DomainError('feishu_relay_unavailable',503);
      await delay(Math.max(100,pollMs),undefined,{signal});
    }
    throw new DomainError('feishu_oauth_expired',409);
  }};
}

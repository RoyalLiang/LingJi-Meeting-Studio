import {FEISHU_CALLBACK,FEISHU_RELAY_ORIGIN,FEISHU_REDIRECT_URI,FEISHU_AUTHORIZE_URL,FEISHU_TOKEN_URL,FEISHU_SCOPES} from '../../../packages/records/src/feishu-oauth.mjs';

export const RELAY_ID='lingji-feishu-auth-v1';
const revision=import.meta.env?.RELAY_REVISION||'local';
const base='/api/integrations/feishu',encoder=new TextEncoder(),token=/^[A-Za-z0-9_-]{43}$/,hashPattern=/^[a-f0-9]{64}$/;
const privateHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'Permissions-Policy':'microphone=(), camera=()'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...privateHeaders,'Content-Type':'application/json; charset=utf-8'}});
class RelayError extends Error {constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const requireThat=(condition,code,status)=>{if(!condition)throw new RelayError(code,status);};
export const relayHash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const bytes=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const base64=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function cipher(env,stateHash,value){
  const key=await crypto.subtle.importKey('raw',bytes(env.FEISHU_RELAY_KEY),'AES-GCM',false,['encrypt','decrypt']);
  if(typeof value==='string'){
    const [iv,data]=value.split('.');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(stateHash)},key,bytes(data))));
  }
  const iv=crypto.getRandomValues(new Uint8Array(12));return base64(iv)+'.'+base64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(stateHash)},key,encoder.encode(JSON.stringify(value))));
}
async function input(request){
  requireThat(request.headers.get('content-type')?.startsWith('application/json'),'invalid_request',415);
  requireThat(request.body,'invalid_request');const reader=request.body.getReader();let size=0;const chunks=[];
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;requireThat(size<=2048,'request_too_large',413);chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new RelayError('invalid_request');}
}
function page(ok,status=200){return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>聆记 · 飞书授权</title><style>body{margin:0;background:#f2f6f2;color:#244637;font:16px/1.7 system-ui}main{max-width:620px;margin:12vh auto;padding:32px}h1{font-size:26px}code{overflow-wrap:anywhere}</style><main><h1>${ok?'授权结果已收到':'未完成飞书授权'}</h1><p>${ok?'可以返回聆记，本机正在安全领取结果。':'请返回聆记检查应用配置，重新发起连接。'}</p><p>应用密钥、令牌和会议正文不经过此回调页面。</p></main></html>`,{status,headers:{...privateHeaders,'Content-Type':'text/html; charset=utf-8'}});}
function configuration(){return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>聆记 · 飞书认证配置</title><style>body{margin:0;background:#f2f6f2;color:#244637;font:16px/1.7 system-ui}main{max-width:720px;margin:8vh auto;padding:24px}h1{font-size:28px}h2{font-size:18px;margin-top:28px}code{display:block;padding:16px;background:#e5eee8;border-radius:10px;overflow-wrap:anywhere}li{overflow-wrap:anywhere}a{color:#24694e}</style><main><h1>飞书授权回调已就绪</h1><p>请在飞书开发者后台 → 安全设置 → 重定向 URL 中登记以下完整地址：</p><code>${FEISHU_REDIRECT_URI}</code><h2>在聆记本机配置应用凭据</h2><p>填写自己的 App ID 和 App Secret，保存后点击“连接飞书”。请勿在此页面、聊天或会议内容中填写密钥。</p><h2>申请用户权限并发布应用版本</h2><ul>${FEISHU_SCOPES.map(scope=>`<li>${scope}</li>`).join('')}</ul><p>此 URL 是 OAuth 回调，公开接收授权结果，不配置 Basic Auth、Bearer 或 Cloudflare Access 登录。Webhook Verification Token 与 Encrypt Key 不适用于此地址。</p><p>本机凭独立领取密钥接收结果；密钥、令牌和会议正文不经过此中继。直接打开本页不会完成用户授权。</p><a href="https://open.feishu.cn/app" rel="noreferrer noopener">打开飞书开发者后台</a></main></html>`,{headers:{...privateHeaders,'Content-Type':'text/html; charset=utf-8'}});}

export function createFeishuRelay({now=Date.now}={}){
  async function rate(db,request,action){
    const ip=await relayHash(request.headers.get('cf-connecting-ip')||'local');
    for(const [bucket,limit]of [[action+':global',1000],[action+':'+ip,action==='register'?20:120]]){
      const row=await db.prepare('INSERT INTO oauth_rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count').bind(bucket,now()+60000,now(),now()).first();
      requireThat(row.count<=limit,'relay_rate_limited',429);
    }
  }
  return {async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    try{
      requireThat(url.protocol==='https:'&&(url.origin===FEISHU_RELAY_ORIGIN||url.hostname==='lingji-feishu-auth.pages.dev'||url.hostname.endsWith('.lingji-feishu-auth.pages.dev')),'origin_rejected',403);
      requireThat(env.LINGJI_FEISHU_RELAY_ID===RELAY_ID&&env.DB&&token.test(env.FEISHU_RELAY_KEY||''),'relay_not_configured',503);
      if(request.method==='GET'&&(path==='/'||path===FEISHU_CALLBACK&&!url.search))return configuration();
      if(request.method==='GET'&&path===`${base}/config`)return json({service:RELAY_ID,revision,redirectUri:FEISHU_REDIRECT_URI,authorizationEndpoint:FEISHU_AUTHORIZE_URL,tokenEndpoint:FEISHU_TOKEN_URL,scopes:FEISHU_SCOPES,callbackAuthentication:'OAuth state (no Basic Auth, Bearer or Access login)',claimAuthentication:'Bearer device-generated claim key',storesMeetingContent:false,storesAppSecret:false});
      const db=env.DB.withSession('first-primary');
      if(path===`${base}/transactions`&&request.method==='POST'){
        await rate(db,request,'register');const value=await input(request);
        requireThat(value&&Object.keys(value).sort().join(',')==='challenge,claimHash,clientId,state'&&token.test(value.state)&&token.test(value.challenge)&&hashPattern.test(value.claimHash)&&/^cli_[A-Za-z0-9_]{6,90}$/.test(value.clientId),'invalid_request');
        const stateHash=await relayHash(value.state),expiresAt=now()+600000;
        await db.prepare('DELETE FROM oauth_transactions WHERE state_hash IN (SELECT state_hash FROM oauth_transactions WHERE expires_at<=? OR result_expires_at<=? LIMIT 100)').bind(now(),now()).run();
        await db.prepare('DELETE FROM oauth_rate_limits WHERE bucket IN (SELECT bucket FROM oauth_rate_limits WHERE expires_at<=? LIMIT 100)').bind(now()).run();
        await db.prepare('INSERT INTO oauth_transactions(state_hash,client_id,challenge,claim_hash,created_at,expires_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM oauth_transactions)<1000 ON CONFLICT(state_hash) DO NOTHING').bind(stateHash,value.clientId,value.challenge,value.claimHash,now(),expiresAt).run();
        const row=await db.prepare('SELECT client_id,challenge,claim_hash,expires_at,status FROM oauth_transactions WHERE state_hash=?').bind(stateHash).first();
        requireThat(row,'relay_capacity',429);requireThat(row.client_id===value.clientId&&row.challenge===value.challenge&&row.claim_hash===value.claimHash,'transaction_conflict',409);
        requireThat(row.expires_at>now()&&row.status==='pending','authorization_expired',410);
        return json({id:stateHash,expiresAt:row.expires_at,redirectUri:FEISHU_REDIRECT_URI},201);
      }
      if(path===FEISHU_CALLBACK&&request.method==='GET'){
        await rate(db,request,'callback');const state=url.searchParams.get('state'),code=url.searchParams.get('code'),error=url.searchParams.get('error');
        requireThat(url.search.length<=16000&&url.searchParams.getAll('state').length===1&&token.test(state||''),'authorization_invalid');
        requireThat(code&&!url.searchParams.has('error')&&url.searchParams.getAll('code').length===1&&/^[\x21-\x7e]{1,4096}$/.test(code)||error==='access_denied'&&!url.searchParams.has('code')&&url.searchParams.getAll('error').length===1,'authorization_invalid');
        const stateHash=await relayHash(state),result=await cipher(env,stateHash,error?{error}:{code});
        const updated=await db.prepare("UPDATE oauth_transactions SET status='ready',result=?,result_expires_at=? WHERE state_hash=? AND status='pending' AND expires_at>?").bind(result,now()+120000,stateHash,now()).run();
        requireThat(updated.meta.changes===1,'authorization_expired',410);return page(true);
      }
      const transaction=path.match(/^\/api\/integrations\/feishu\/transactions\/([a-f0-9]{64})$/);
      if(transaction&&['GET','DELETE'].includes(request.method)){
        await rate(db,request,'claim');const claim=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];requireThat(claim,'claim_rejected',401);
        const claimHash=await relayHash(claim),row=await db.prepare('SELECT * FROM oauth_transactions WHERE state_hash=? AND claim_hash=?').bind(transaction[1],claimHash).first();
        requireThat(row,'claim_rejected',401);
        if(request.method==='DELETE'){await db.prepare("UPDATE oauth_transactions SET status='closed',result=NULL WHERE state_hash=? AND claim_hash=?").bind(transaction[1],claimHash).run();return json({closed:true});}
        if(row.expires_at<=now()||row.result_expires_at&&row.result_expires_at<=now()||row.status==='closed'){
          await db.prepare("UPDATE oauth_transactions SET status='closed',result=NULL WHERE state_hash=?").bind(transaction[1]).run();throw new RelayError('authorization_expired',410);
        }
        if(row.status==='pending')return json({status:'pending',expiresAt:row.expires_at});
        return json({status:'ready',expiresAt:Math.min(row.expires_at,row.result_expires_at),...await cipher(env,transaction[1],row.result)});
      }
      throw new RelayError('not_found',404);
    }catch(error){
      if(path===FEISHU_CALLBACK)return page(false,error instanceof RelayError?error.status:503);
      return json({error:error instanceof RelayError?error.code:'relay_unavailable'},error instanceof RelayError?error.status:503);
    }
  }};
}
export default createFeishuRelay();

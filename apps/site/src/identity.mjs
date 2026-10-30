import { SignJWT, jwtVerify } from 'jose';
import { ShareContentError } from '../../../packages/records/src/published-content.mjs';

const sessionCookie='__Host-lingji_publisher', flowCookie='__Host-lingji_oauth';
const encoder=new TextEncoder();
const cookie=(name,value,seconds)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const readCookie=(request,name)=>(request.headers.get('cookie') || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function publishingConfigured(env){
  try{return /^[A-Za-z0-9_.-]{12,128}$/.test(env.GITHUB_CLIENT_ID || '') && typeof env.GITHUB_CLIENT_SECRET==='string' && env.GITHUB_CLIENT_SECRET.length>=32 && /^\d+$/.test(env.PUBLISHER_GITHUB_ID || '') && new URL(env.PUBLIC_SITE_ORIGIN).origin===env.PUBLIC_SITE_ORIGIN && env.PUBLIC_SITE_ORIGIN.startsWith('https://');}catch{return false;}
}
function configured(env){if(!publishingConfigured(env))throw new ShareContentError('publishing_not_configured',503);}
async function sign(payload,env,audience,seconds){return new SignJWT(payload).setProtectedHeader({alg:'HS256'}).setIssuer(env.PUBLIC_SITE_ORIGIN).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+seconds).sign(encoder.encode(env.GITHUB_CLIENT_SECRET));}
async function verify(token,env,audience){
  if(!token || token.length>4096)throw new Error('missing_cookie');
  const {payload}=await jwtVerify(token,encoder.encode(env.GITHUB_CLIENT_SECRET),{issuer:env.PUBLIC_SITE_ORIGIN,audience,algorithms:['HS256'],requiredClaims:['exp','iat','iss','aud']});return payload;
}
export async function publisher(request,env){
  configured(env);
  try{
    if(new URL(request.url).origin!==env.PUBLIC_SITE_ORIGIN)throw new Error('wrong_origin');
    const payload=await verify(readCookie(request,sessionCookie),env,'publisher');
    if(payload.sub!==env.PUBLISHER_GITHUB_ID)throw new Error('wrong_publisher');
    return {id:`github:${payload.sub}`};
  }catch{throw new ShareContentError('publisher_login_required',401);}
}
function redirect(path,env,cookies=[]){const headers=new Headers({'Location':env.PUBLIC_SITE_ORIGIN+path,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});for(const value of cookies)headers.append('Set-Cookie',value);return new Response(null,{status:303,headers});}
export async function authentication(request,env,fetcher=fetch){
  configured(env);
  const url=new URL(request.url);
  if(url.origin!==env.PUBLIC_SITE_ORIGIN)throw new ShareContentError('publisher_login_required',401);
  if(url.pathname==='/auth/login' && request.method==='GET'){
    const state=random(),verifier=random();
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)));
    const challenge=btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    const target=new URL('https://github.com/login/oauth/authorize');
    target.search=new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:env.PUBLIC_SITE_ORIGIN+'/auth/callback',scope:'',login:'RoyalLiang',state,code_challenge:challenge,code_challenge_method:'S256',allow_signup:'false'});
    return new Response(null,{status:303,headers:{Location:target.href,'Set-Cookie':cookie(flowCookie,await sign({state,verifier},env,'oauth-flow',600),600),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  if(url.pathname==='/auth/logout' && request.method==='POST'){
    if(request.headers.get('origin')!==env.PUBLIC_SITE_ORIGIN)throw new ShareContentError('origin_rejected',403);
    return redirect('/publish',env,[cookie(sessionCookie,'',0),cookie(flowCookie,'',0)]);
  }
  if(url.pathname==='/auth/callback' && request.method==='GET'){
    try{
      const flow=await verify(readCookie(request,flowCookie),env,'oauth-flow'),code=url.searchParams.get('code');
      if(!code || code.length>512 || flow.state!==url.searchParams.get('state') || typeof flow.verifier!=='string' || flow.verifier.length!==43)throw new Error('invalid_oauth_state');
      const response=await fetcher('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:env.PUBLIC_SITE_ORIGIN+'/auth/callback',code_verifier:flow.verifier}),signal:AbortSignal.timeout(15000)});
      const token=await response.json();
      if(!response.ok || typeof token.access_token!=='string' || token.access_token.length>1024 || token.scope!=='' || token.token_type?.toLowerCase()!=='bearer')throw new Error('invalid_oauth_token');
      const userResponse=await fetcher('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'LingJi-Beta'},signal:AbortSignal.timeout(15000)});
      const user=await userResponse.json();
      if(!userResponse.ok || !Number.isSafeInteger(user.id) || String(user.id)!==env.PUBLISHER_GITHUB_ID || user.login!=='RoyalLiang')throw new Error('publisher_not_allowed');
      return redirect('/publish',env,[cookie(flowCookie,'',0),cookie(sessionCookie,await sign({sub:String(user.id)},env,'publisher',28800),28800)]);
    }catch{
      return new Response('登录未完成或当前 GitHub 账户无发布权限。请返回发布页重新登录。',{status:401,headers:{'Content-Type':'text/plain; charset=utf-8','Set-Cookie':cookie(flowCookie,'',0),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
  }
  throw new ShareContentError('not_found',404);
}

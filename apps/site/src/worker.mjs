import { normalizePublishedContent, ShareContentError } from '../../../packages/records/src/published-content.mjs';
import { createShareDocument } from '../../web/src/share-content.ts';
import { publisher } from './identity.mjs';
import { exampleContent } from './example.mjs';

export const MAX_SHARE_BYTES=2*1024*1024;
const encoder=new TextEncoder(), invalidReads=new Map();
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const privacy={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...privacy,'Content-Type':'application/json; charset=utf-8'}});
export const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const database=env=>env.DB.withSession('first-primary');

async function body(request){
  if(!request.body)throw new ShareContentError();
  const reader=request.body.getReader(), chunks=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_SHARE_BYTES)throw new ShareContentError('share_too_large',413);chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const all=new Uint8Array(bytes);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new ShareContentError();}
}
function sameOrigin(request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new ShareContentError('origin_rejected',403);}
function ready(env){if(!env.DB || !env.BUCKET)throw new ShareContentError('sharing_not_configured',503);}
function reserveRead(request){
  const key=request.headers.get('cf-connecting-ip') || 'unknown',now=Date.now();
  let value=invalidReads.get(key);
  if(value?.reset<=now){invalidReads.delete(key);value=undefined;}
  if(value?.count>=60)throw new ShareContentError('share_rate_limited',429);
  if(invalidReads.size>=10000){for(const [id,entry] of invalidReads)if(entry.reset<=now)invalidReads.delete(id);if(!value && invalidReads.size>=10000)throw new ShareContentError('share_rate_limited',429);}
  value ||= {count:0,reset:now+60000};value.count++;invalidReads.set(key,value);return value;
}
function document(content,expires){
  let html=createShareDocument({id:content.sourceRecordId,title:content.title,capture:content.draft?'recording':'completed',minutes:content.minutes,segments:content.segments || []},content.scope,true);
  if(expires){
    html=html.replace("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'","default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    html=html.replace('</footer>',`<p id="share-status" role="status" data-expires="${expires}">只读快照 · 24 小时有效，可由发布者撤销。已保存的副本无法收回。</p></footer>`).replace('</body>','<script type="module" src="/share-status.js"></script></body>');
  }
  return new Response(html,{headers:{...privacy,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'Permissions-Policy':'microphone=(), camera=()'}});
}
async function ownRequest(db,owner,requestId){return db.prepare('SELECT * FROM shares WHERE owner_id=? AND request_id=?').bind(owner,requestId).first();}
function replay(row,tokenHash,payloadHash,token){
  if(row.token_hash!==tokenHash || row.payload_hash!==payloadHash)throw new ShareContentError('publish_request_conflict',409);
  if(row.revoked_at || row.expires_at<=Date.now())throw new ShareContentError('share_expired_or_revoked',410);
  return json({id:row.id,path:`/share/${token}`,expires:row.expires_at});
}
export function createSiteWorker({identify=publisher}={}){
  return {async fetch(request,env){
    try{
      const url=new URL(request.url),path=url.pathname;
      if(path==='/example' && request.method==='GET')return document(exampleContent);
      if(path==='/api/site-status' && request.method==='GET')return json({publishing:Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.DB && env.BUCKET)});
      const shared=path.match(/^\/(share|api\/shared)\/([A-Za-z0-9_-]{43})(\/status)?$/);
      if(shared && request.method==='GET'){
        ready(env);const permit=reserveRead(request);
        const db=database(env),tokenHash=await hash(shared[2]);
        let row;
        try{row=await db.prepare('SELECT * FROM shares WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(tokenHash,Date.now()).first();}catch(error){permit.count--;throw error;}
        if(!row)throw new ShareContentError('share_expired_or_revoked',404);
        permit.count--;
        if(shared[3])return json({valid:true,expires:row.expires_at});
        const stored=await env.BUCKET.get(row.object_key);if(!stored)throw new ShareContentError('shared_content_unavailable',503);
        const content=normalizePublishedContent({...JSON.parse(await stored.text()),sourceRecordId:row.source_record_id});
        if(await hash(JSON.stringify(content))!==row.payload_hash)throw new ShareContentError('shared_content_unavailable',503);
        return document(content,row.expires_at);
      }
      if(path==='/api/published' || path==='/api/publish' || /^\/api\/published\/[a-f0-9-]{36}$/.test(path)){
        ready(env);const owner=await identify(request,env),db=database(env);
        if(path==='/api/published' && request.method==='GET'){
          const result=await db.prepare('SELECT id,title,scope,created_at,expires_at,revoked_at FROM shares WHERE owner_id=? ORDER BY (revoked_at IS NULL AND expires_at>?) DESC,created_at DESC LIMIT 100').bind(owner.id,Date.now()).all();return json({shares:result.results});
        }
        if(path==='/api/publish' && request.method==='POST'){
          sameOrigin(request);const input=await body(request);
          if(!input || typeof input!=='object' || Array.isArray(input))throw new ShareContentError();
          if(!uuidPattern.test(input.requestId) || !tokenPattern.test(input.token))throw new ShareContentError();
          const content=normalizePublishedContent(input.content),payload=JSON.stringify(content);
          const [tokenHash,payloadHash]=await Promise.all([hash(input.token),hash(payload)]);
          const existing=await ownRequest(db,owner.id,input.requestId);if(existing)return replay(existing,tokenHash,payloadHash,input.token);
          const id=crypto.randomUUID(),objectKey=`shares/${id}.json`,now=Date.now(),expires=now+86400000;
          const stored={...content};delete stored.sourceRecordId;
          await env.BUCKET.put(objectKey,JSON.stringify(stored),{httpMetadata:{contentType:'application/json; charset=utf-8'}});
          try{
            const result=await db.prepare('INSERT INTO shares(id,owner_id,request_id,token_hash,object_key,payload_hash,title,source_record_id,scope,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM shares WHERE owner_id=? AND revoked_at IS NULL AND expires_at>?)<100').bind(id,owner.id,input.requestId,tokenHash,objectKey,payloadHash,content.title,content.sourceRecordId,content.scope,now,expires,owner.id,now).run();
            if(!result.meta.changes){await env.BUCKET.delete(objectKey);throw new ShareContentError('active_share_limit',429);}
          }catch(error){
            let confirmed;
            try{confirmed=await ownRequest(db,owner.id,input.requestId);}catch{throw new ShareContentError('publish_retry_required',503);}
            if(confirmed){if(confirmed.object_key!==objectKey)await env.BUCKET.delete(objectKey);return replay(confirmed,tokenHash,payloadHash,input.token);}
            await env.BUCKET.delete(objectKey);if(error instanceof ShareContentError)throw error;throw new ShareContentError('publish_failed_retry',503);
          }
          return json({id,path:`/share/${input.token}`,expires},201);
        }
        if(request.method==='DELETE'){
          sameOrigin(request);const id=path.split('/').at(-1),row=await db.prepare('SELECT * FROM shares WHERE id=? AND owner_id=?').bind(id,owner.id).first();
          if(!row)throw new ShareContentError('not_found',404);
          await db.prepare('UPDATE shares SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND owner_id=?').bind(Date.now(),id,owner.id).run();
          try{await env.BUCKET.delete(row.object_key);return json({revoked:true,cleanup:'completed'});}catch{return json({revoked:true,cleanup:'pending'});}
        }
        throw new ShareContentError('not_found',404);
      }
      if(path.startsWith('/api/') || path.startsWith('/share/'))throw new ShareContentError('not_found',404);
      if(!['GET','HEAD'].includes(request.method))throw new ShareContentError('method_not_allowed',405);
      const response=await env.ASSETS.fetch(request),headers=new Headers(response.headers);
      headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      headers.set('Permissions-Policy','microphone=(), camera=()');
      if(path==='/publish' || path==='/publish.html'){headers.set('Cache-Control','no-store');headers.set('X-Robots-Tag','noindex, nofollow');}
      return new Response(response.body,{status:response.status,headers});
    }catch(error){
      const status=error instanceof ShareContentError?error.status:503;
      if(new URL(request.url).pathname.startsWith('/share/')){
        const message=status===404 || status===410?'链接已到期或已撤销':status===429?'访问过于频繁，请稍后重试':'暂时无法读取纪要，请稍后重试';
        return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${message} · 聆记</title><link rel="stylesheet" href="/site.css"><main class="publisher wrap"><h1>${message}</h1><p>请向发布者确认链接状态。已经保存的内容副本无法收回。</p><a href="/">聆记首页</a></main></html>`,{status,headers:{...privacy,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"}});
      }
      return json({error:error instanceof ShareContentError?error.code:'sharing_unavailable'},status);
    }
  }};
}
export default createSiteWorker();

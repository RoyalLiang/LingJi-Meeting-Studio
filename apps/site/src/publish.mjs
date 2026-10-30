import { normalizePublishedContent } from '../../../packages/records/src/published-content.mjs';
import { createShareDocument } from '../../web/src/share-content.ts';

const byId=id=>document.getElementById(id), file=byId('content-file'), consent=byId('consent'), submit=byId('publish-button');
let content=null, ready=false, busy=false, generation=0;
const messages={publisher_login_required:'请使用受邀邮箱登录后重试。',publishing_not_configured:'发布身份尚未配置，请联系维护者。',sharing_not_configured:'发布存储尚未配置。',publish_request_conflict:'重试内容发生变化，请重新选择文件。',active_share_limit:'有效链接已达上限，请先撤销不用的链接。',share_too_large:'文件超过 2 MiB。',invalid_share_content:'文件内容或引用版本不完整，请从桌面版重新导出。'};
const enable=()=>{submit.disabled=!ready || !content || !consent.checked || busy;};
async function request(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers},cache:'no-store',signal:AbortSignal.timeout(30000)});
  const value=await response.json().catch(()=>({error:'publisher_login_required'}));
  if(!response.ok)throw new Error(messages[value.error] || '服务暂不可用。请保留文件，稍后重试。');
  return value;
}
async function history(){
  const status=byId('history-status'), list=byId('history-list');
  status.textContent='正在读取…';
  try{
    const {shares}=await request('/api/published');ready=true;enable();list.replaceChildren();
    status.textContent=shares.length?'链接只在创建时展示，请自行保存；这里始终可以撤销。':'还没有已发布的链接。';
    for(const share of shares){
      const row=document.createElement('div'), label=document.createElement('div'), title=document.createElement('strong'), detail=document.createElement('p');
      row.className='history-row';title.textContent=share.title;
      const active=!share.revoked_at && share.expires_at>Date.now();
      detail.textContent=`${share.scope==='minutes'?'仅纪要及引用':'纪要与全部转录'} · ${share.revoked_at?'已撤销':active?'有效至 '+new Date(share.expires_at).toLocaleString('zh-CN'):'已到期'}`;
      label.append(title,detail);row.append(label);
      if(active){const button=document.createElement('button');button.className='ghost';button.textContent='撤销';button.addEventListener('click',async()=>{button.disabled=true;try{const result=await request(`/api/published/${share.id}`,{method:'DELETE'});await history();status.textContent=result.cleanup==='pending'?'链接已撤销，正文清理仍待完成。':'链接已撤销，正文已清理。';}catch(error){status.textContent=error.message;button.disabled=false;}});row.append(button);}
      list.append(row);
    }
  }catch(error){ready=false;enable();status.textContent=error.message;}
}
file.addEventListener('change',async()=>{
  const current=++generation;content=null;consent.checked=false;byId('preview').hidden=true;byId('result').hidden=true;enable();
  try{
    const selected=file.files[0];if(!selected)return;if(selected.size>2*1024*1024)throw new Error(messages.share_too_large);
    const parsed=normalizePublishedContent(JSON.parse(await selected.text()));if(current!==generation)return;
    content=parsed;const preview=byId('preview');preview.srcdoc=createShareDocument({id:parsed.sourceRecordId,title:parsed.title,capture:parsed.draft?'recording':'completed',minutes:parsed.minutes,segments:parsed.segments || []},parsed.scope,true);preview.hidden=false;
    byId('selection').textContent=`${parsed.title} · ${parsed.scope==='minutes'?'仅纪要及引用原文':'纪要与全部转录'}${parsed.draft?' · 草稿':''}`;
  }catch(error){if(current===generation)byId('selection').textContent=error.message===messages.share_too_large?error.message:messages.invalid_share_content;}
  enable();
});
consent.addEventListener('change',enable);
byId('refresh-shares').addEventListener('click',()=>void history());
byId('publish-form').addEventListener('submit',async event=>{
  event.preventDefault();if(submit.disabled)return;busy=true;file.disabled=true;consent.disabled=true;enable();byId('message').textContent='正在发布…';
  try{
    const payload=JSON.stringify(content), digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))),b=>b.toString(16).padStart(2,'0')).join('');
    let attempt;try{attempt=JSON.parse(sessionStorage.getItem('lingji-publish-attempt'));}catch{}
    if(!attempt || attempt.digest!==digest){const token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');attempt={digest,token,requestId:crypto.randomUUID()};sessionStorage.setItem('lingji-publish-attempt',JSON.stringify(attempt));}
    const result=await request('/api/publish',{method:'POST',body:JSON.stringify({...attempt,content})});
    if(!/^\/share\/[A-Za-z0-9_-]{43}$/.test(result.path))throw new Error('发布结果不完整，请保留文件后重试。');
    const url=location.origin+result.path;byId('share-url').value=url;byId('open-link').href=url;byId('expires').textContent='有效至 '+new Date(result.expires).toLocaleString('zh-CN');byId('result').hidden=false;byId('message').textContent='已发布。请复制并保存链接。';sessionStorage.removeItem('lingji-publish-attempt');consent.checked=false;await history();
  }catch(error){byId('message').textContent=error.message;}
  finally{busy=false;file.disabled=false;consent.disabled=false;enable();}
});
byId('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(byId('share-url').value);byId('message').textContent='链接已复制。';}catch{byId('share-url').focus();byId('share-url').select();byId('message').textContent='请选中链接手动复制。';}});
try{const status=await request('/api/site-status');byId('service-status').textContent=status.publishing?'发布服务已配置。请使用受邀身份继续。':'官网已就绪，发布服务仍待维护者完成配置。';if(status.publishing)await history();else byId('history-status').textContent='发布服务就绪后可在这里管理链接。';}catch{byId('service-status').textContent='暂无法连接发布服务，请稍后刷新。';}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { Button } from './ui';
import { ExternalLink } from './ExternalLink';
import './FeishuExport.css';
export type FeishuConnectionValue={appId:string;hasSecret:boolean;redirectUri:string;connected:boolean;identity:{name:string;tenantKey:string}|null;scopes:string[]};
const endpoint='/integrations/feishu';
export function FeishuConnection({onChange,disabled=false}:{onChange:(value:FeishuConnectionValue)=>void;disabled?:boolean}){
  const [value,setValue]=useState<FeishuConnectionValue|null>(null),[editing,setEditing]=useState(false),[auth,setAuth]=useState<{url:string;expiresAt:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),pending=useRef(false);
  const store=(next:FeishuConnectionValue)=>{setValue(next);onChange(next);if(next.connected)setAuth(null);};
  useEffect(()=>{let active=true;api<FeishuConnectionValue>(endpoint).then(next=>{if(active){setValue(next);onChange(next);}}).catch(failure=>{if(active)setError(messageOf(failure));});return()=>{active=false;};},[onChange]);
  useEffect(()=>{if(!auth)return;let active=true,loading=false;const timer=setInterval(()=>{if(Date.now()>auth.expiresAt){setAuth(null);setNotice('授权链接已过期，请重新连接。');return;}if(loading)return;loading=true;api<FeishuConnectionValue>(endpoint).then(next=>{if(active&&next.connected){setValue(next);onChange(next);setAuth(null);setNotice('飞书已连接。');}}).catch(()=>{}).finally(()=>{loading=false;});},2500);return()=>{active=false;clearInterval(timer);};},[auth,onChange]);
  const perform=async(action:()=>Promise<void>)=>{if(pending.current||disabled)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(failure){setError(messageOf(failure));}finally{pending.current=false;setBusy(false);}};
  const save=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=event.currentTarget,input=Object.fromEntries(new FormData(form));void perform(async()=>{store(await api<FeishuConnectionValue>(endpoint,'PUT',input));form.reset();setEditing(false);setAuth(null);setNotice('配置已保存，请连接飞书。');});};
  return <div className="feishu-export"><div className="feishu-connection"><div><strong>飞书云文档</strong><p>{value?.connected?`已连接 · ${value.identity?.name||'飞书用户'} · 租户 ${value.identity?.tenantKey}`:'连接飞书后，导出为你名下的新文档。'}</p></div><Button disabled={!value||busy||disabled} onClick={()=>setEditing(!editing)}>{editing?'收起配置':value?.hasSecret?'应用配置':'配置应用'}</Button></div>
    {editing&&value&&<form className="feishu-config" onSubmit={save}><p className="fine-print">在飞书开放平台创建企业自建应用，开通下列用户权限并发布应用版本。凭据由后台加密保存，不提供给模型。</p>
      <label>App ID<input name="appId" required defaultValue={value.appId} autoComplete="off" placeholder="cli_…"/></label><label>App Secret<input name="appSecret" type="password" required={!value.hasSecret} autoComplete="new-password" placeholder={value.hasSecret?'已保存；留空保留':'应用凭据中的 App Secret'}/></label>
      <label>授权回调地址<input name="redirectUri" type="url" required defaultValue={value.redirectUri}/></label><p className="fine-print">将此完整地址加入飞书应用的重定向 URL。本机使用固定回调端口；托管 Web 服务填写自己的 HTTPS 回调地址。</p><p className="fine-print feishu-scopes">所需权限：{value.scopes.join('、')}</p><div className="feishu-actions"><ExternalLink href="https://open.feishu.cn/app">打开飞书开发者后台</ExternalLink><Button type="submit" variant="primary" disabled={busy||disabled}>保存配置</Button></div></form>}
    {value?.hasSecret&&<div className="feishu-actions">{value.connected?<Button variant="ghost" disabled={busy||disabled} onClick={()=>void perform(async()=>{store(await api<FeishuConnectionValue>(endpoint,'DELETE'));setAuth(null);})}>断开本地连接</Button>:<Button disabled={busy||disabled} onClick={()=>void perform(async()=>setAuth(await api(`${endpoint}/authorize`,'POST',{})))}>连接飞书</Button>}{auth&&<ExternalLink href={auth.url}>前往飞书授权</ExternalLink>}</div>}
    {notice&&<p className="notice" role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}<Button disabled={busy} onClick={()=>void perform(async()=>store(await api<FeishuConnectionValue>(endpoint)))}>重试</Button></p>}
  </div>;
}

import {FeedbackNotice} from './FeedbackNotice';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, messageOf } from '../api';
import { Button } from './ui';
import {CapabilitySwitch} from './CapabilitySwitch';
import './FeishuExport.css';
export type FeishuConnectionValue={authMode:'app';appId:string;hasSecret:boolean;enabled:boolean;connected:boolean;connection:{state:string;reconnectAttempts:number};scopes:string[]};
const endpoint='/integrations/feishu';
const healthLabels:Record<string,string>={healthy:'连接正常',pending:'正在连接或重连',error:'连接异常',disabled:'能力已停用',unconfigured:'尚未配置'};
export function FeishuConnection({onChange,disabled=false}:{onChange:(value:FeishuConnectionValue)=>void;disabled?:boolean}){
  const [value,setValue]=useState<FeishuConnectionValue|null>(null),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),pending=useRef(false);
  const store=(next:FeishuConnectionValue)=>{setValue(next);onChange(next);};
  useEffect(()=>{let active=true;api<FeishuConnectionValue>(endpoint).then(next=>{if(active){setValue(next);onChange(next);}}).catch(failure=>{if(active)setError(messageOf(failure));});return()=>{active=false;};},[onChange]);
  useEffect(()=>{if(!value?.enabled)return;let active=true,loading=false;const timer=setInterval(()=>{if(loading||document.visibilityState==='hidden')return;loading=true;api<FeishuConnectionValue>(endpoint).then(next=>{if(active){setValue(next);onChange(next);}}).catch(()=>{}).finally(()=>{loading=false;});},2500);return()=>{active=false;clearInterval(timer);};},[value?.enabled,onChange]);
  const perform=async(action:()=>Promise<void>)=>{if(pending.current||disabled)return;pending.current=true;setBusy(true);setError('');try{await action();}catch(error){setError(messageOf(error));}finally{pending.current=false;setBusy(false);}};
  const save=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=event.currentTarget,input=Object.fromEntries(new FormData(form));void perform(async()=>{store(await api<FeishuConnectionValue>(endpoint,'PUT',input));form.reset();setEditing(false);});};
  const phase=value?.connection.state,health=!value?.hasSecret?'unconfigured':!value.enabled?'disabled':phase==='connected'?'healthy':['connecting','reconnecting'].includes(phase||'')?'pending':'error';
  return <div className="feishu-export"><div className="collaboration-tool">
    <button type="button" className="collaboration-tool-config" aria-label={`配置飞书协同，${healthLabels[health]}`} disabled={busy||disabled} onClick={()=>setEditing(!editing)}><span className="collaboration-tool-icon" aria-hidden="true">飞</span><strong>飞书</strong><span className={`collaboration-health ${health}`} role="img" aria-label={healthLabels[health]} title={healthLabels[health]}/></button>
    <CapabilitySwitch label="启用飞书协同" enabled={Boolean(value?.enabled)} disabled={busy||disabled||!value?.hasSecret} onChange={enabled=>void perform(async()=>{store(await api<FeishuConnectionValue>(endpoint,'PATCH',{enabled}));})}/>
  </div>
    {editing&&value&&<form className="feishu-config" onSubmit={save}>
      <label>App ID<input name="appId" required defaultValue={value.appId} pattern="cli_[a-fA-F0-9]{16}" placeholder="cli_…" disabled={busy||disabled}/></label><label>App Secret<input name="appSecret" type="password" required={!value.hasSecret} autoComplete="new-password" placeholder={value.hasSecret?'已保存；留空保留':'应用凭据中的 Secret'} disabled={busy||disabled}/></label>
      <details><summary>应用权限</summary><p className="fine-print feishu-scopes">{value.scopes.join('、')}</p></details><div className="feishu-actions"><Button variant="primary" disabled={busy||disabled}>保存配置</Button></div>
    </form>}
    {error&&<FeedbackNotice key={error} message={error} error/>}
  </div>;
}

import {createPortal} from 'react-dom';
import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {Globe} from '@phosphor-icons/react';
import {api, messageOf} from '../api';
import {Button} from './ui';
import {Select} from './Select';
import {Toast} from './Toast';
import './NetworkSettings.css';

type Settings = {mode:'system'|'manual'|'direct'; url:string; username:string; hasPassword:boolean};
export function NetworkSettings({actionsTarget}:{actionsTarget:HTMLElement|null}) {
  const [value,setValue]=useState<Settings|null>(null),[password,setPassword]=useState(''),[clearPassword,setClearPassword]=useState(false);
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const pending=useRef(false), passwordId=useId();
  useEffect(()=>{const controller=new AbortController();api<Settings>('/settings/network-proxy','GET',undefined,controller.signal).then(setValue).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});return()=>controller.abort();},[]);
  const edit=(patch:Partial<Settings>)=>{setValue(current=>current?{...current,...patch}:current);setDirty(true);setNotice('');};
  const save=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!value||pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try { const next=await api<Settings>('/settings/network-proxy','PUT',{...value,password,clearPassword});setValue(next);setPassword('');setClearPassword(false);setDirty(false);setNotice('代理设置已保存'); }
    catch(error){setError(messageOf(error));}finally{pending.current=false;setBusy(false);}
  };
  return <section className="settings-section provider-settings-surface">
    <Toast message={error||notice} error={Boolean(error)} dismiss={()=>{setError('');setNotice('');}}/>
    <form id="network-settings" className="provider-form" onSubmit={save} aria-busy={busy||!value}>
      <section className="provider-module"><div className="provider-module-copy"><h3>网络代理</h3></div><div className="provider-module-fields">
        <div className="settings-heading-row"><div className="section-title"><Globe size={19}/><h3>连接方式</h3></div><Select label="代理模式" readOnly={!value||busy} value={value?.mode||'system'} onChange={mode=>edit({mode:mode as Settings['mode']})} options={[{value:'system',label:'系统代理'},{value:'manual',label:'自定义代理'},{value:'direct',label:'不使用代理'}]}/></div>
        {value?.mode==='manual'&&<div className="settings-dependent-fields">
          <label><span title="HTTP / HTTPS / SOCKS5">代理地址</span><input type="url" aria-label="代理地址" autoComplete="off" disabled={busy} required value={value.url} placeholder="http://127.0.0.1:7890" onChange={event=>edit({url:event.target.value})}/></label>
          <label><span>用户名</span><input aria-label="代理用户名" autoComplete="off" disabled={busy} value={value.username} onChange={event=>edit({username:event.target.value})}/></label>
          <div className="network-proxy-password"><div className="settings-field-label"><label htmlFor={passwordId}>密码</label>{value.hasPassword&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{setClearPassword(!clearPassword);setDirty(true);setNotice('');}}>{clearPassword?'保留密码':'清除密码'}</Button>}</div><input id={passwordId} type="password" aria-label="代理密码" autoComplete="new-password" disabled={busy||clearPassword} value={password} placeholder={value.hasPassword&&!clearPassword?'留空保留已保存密码':''} onChange={event=>{setPassword(event.target.value);setDirty(true);setNotice('');}}/></div>
        </div>}
      </div></section>
      {actionsTarget&&createPortal(<><span className="settings-save-state" data-dirty={dirty}>{busy?'正在保存…':error?'保存失败':dirty?'有未保存的更改':notice?'已保存':''}</span><Button form="network-settings" type="submit" variant="primary" disabled={!dirty||busy||!value}>保存设置</Button></>,actionsTarget)}
    </form>
  </section>;
}

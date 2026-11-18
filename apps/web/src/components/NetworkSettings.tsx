import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {api, messageOf} from '../api';
import {Button} from './ui';
import {Select} from './Select';
import './NetworkSettings.css';

type Settings = {mode:'system'|'manual'|'direct'; url:string; username:string; hasPassword:boolean};
export function NetworkSettings({registerSave}:{registerSave:(save:(()=>Promise<void>)|null)=>void}) {
  const [value,setValue]=useState<Settings|null>(null),[password,setPassword]=useState(''),[clearPassword,setClearPassword]=useState(false);
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const pending=useRef<Promise<void>|null>(null),passwordId=useId(),headingId=useId();
  useEffect(()=>{const controller=new AbortController();api<Settings>('/settings/network-proxy','GET',undefined,controller.signal).then(setValue).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});return()=>controller.abort();},[]);
  const edit=(patch:Partial<Settings>)=>{setValue(current=>current?{...current,...patch}:current);setDirty(true);setNotice('');setError('');};
  const save=useCallback(()=>{
    if(pending.current)return pending.current;
    if(!value||!dirty)return Promise.resolve();
    setBusy(true);setError('');
    const operation=api<Settings>('/settings/network-proxy','PUT',{...value,password,clearPassword}).then(next=>{
      setValue(next);setPassword('');setClearPassword(false);setDirty(false);setNotice('已保存');
    }).catch(error=>{setError(messageOf(error));throw error;}).finally(()=>{pending.current=null;setBusy(false);});
    pending.current=operation;return operation;
  },[value,password,clearPassword,dirty]);
  useEffect(()=>{registerSave(save);return()=>registerSave(null);},[registerSave,save]);
  return <section className="settings-section provider-settings-surface network-settings" aria-labelledby={headingId} aria-busy={busy||!value}>
    <section className="provider-module"><div className="provider-module-copy"><h3 id={headingId}>网络连接</h3></div><div className="provider-module-fields">
      <div className="network-overview"><label className="network-mode"><span>连接方式</span><Select label="代理模式" readOnly={!value||busy} value={value?.mode||'system'} onChange={mode=>edit({mode:mode as Settings['mode']})} options={[{value:'system',label:'系统代理'},{value:'manual',label:'自定义代理'},{value:'direct',label:'不使用代理'}]}/></label><span className="network-save-state" role="status">{busy?'正在保存…':dirty?'未保存':notice}</span></div>
      {value?.mode==='manual'&&<>
        <label className="network-address"><span title="HTTP / HTTPS / SOCKS5">代理地址</span><input type="url" aria-label="代理地址" autoComplete="off" disabled={busy} required value={value.url} placeholder="http://127.0.0.1:7890" onChange={event=>edit({url:event.target.value})}/></label>
        <div className="settings-dependent-fields network-proxy-credentials"><label><span className="settings-field-label">用户名（可选）</span><input aria-label="代理用户名" autoComplete="off" disabled={busy} value={value.username} onChange={event=>edit({username:event.target.value})}/></label>
          <div className="network-proxy-password"><div className="settings-field-label"><label htmlFor={passwordId}>密码（可选）</label>{value.hasPassword&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{setClearPassword(!clearPassword);setDirty(true);setNotice('');}}>{clearPassword?'保留密码':'清除密码'}</Button>}</div><input id={passwordId} type="password" aria-label="代理密码" autoComplete="new-password" disabled={busy||clearPassword} value={password} placeholder={value.hasPassword&&!clearPassword?'留空保留已保存密码':''} onChange={event=>{setPassword(event.target.value);setDirty(true);setNotice('');}}/></div>
        </div>
      </>}
      <p className="network-scope">本机录音与本地转录始终直连</p>
      {error&&<p className="network-error" role="alert">{error}</p>}
    </div></section>
  </section>;
}

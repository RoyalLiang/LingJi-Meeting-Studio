import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {isTauri,invoke} from '@tauri-apps/api/core';
import {FolderOpen} from '@phosphor-icons/react';
import {api,messageOf} from '../api';
import {Button} from './ui';
import {Select} from './Select';
import {FeedbackNotice} from './FeedbackNotice';
import {Toast} from './Toast';

type Settings={enabled:boolean;directory:string;retentionDays:number;error?:string};
export function AudioBackupSettings({registerSave}:{registerSave?:(save:(()=>Promise<void>)|null)=>void}){
  const directoryId=useId();
  const [value,setValue]=useState<Settings|null>(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const pending=useRef<Promise<void>|null>(null);
  useEffect(()=>{const controller=new AbortController();api<Settings>('/settings/audio-backup','GET',undefined,controller.signal).then(setValue).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});return()=>controller.abort();},[]);
  const edit=(patch:Partial<Settings>)=>{setValue(current=>current?{...current,...patch}:current);setDirty(true);setSaved(false);setError('');};
  const choose=async()=>{try{const directory=await invoke<string|null>('audio_backup_directory',{initial:value?.directory||null});if(directory)edit({directory});}catch(error){setError(messageOf(error));}};
  const save=useCallback(()=>{
    if(pending.current)return pending.current;
    if(!value||!dirty)return Promise.resolve();
    setBusy(true);setError('');
    const request=(async()=>{
      try{const next=await api<Settings>('/settings/audio-backup','PUT',value);setValue(next);setDirty(false);setSaved(true);}
      catch(error){setError(messageOf(error));throw error;}
      finally{pending.current=null;setBusy(false);}
    })();
    pending.current=request;return request;
  },[value,dirty]);
  useEffect(()=>{registerSave?.(save);return()=>registerSave?.(null);},[registerSave,save]);
  const actions=<Button type="button" disabled={!dirty||busy||!value||value.enabled&&!value.directory.trim()} onClick={()=>void save().catch(()=>{})}>{busy?'正在保存…':'保存音频备份'}</Button>;
  return <section className="settings-section audio-backup-settings">
    <div className="audio-backup-heading"><div className="section-title"><FolderOpen size={19}/><h3>原始音频备份</h3></div>{value&&<label className="checkbox-label"><input type="checkbox" checked={value.enabled} disabled={busy} onChange={event=>edit({enabled:event.target.checked})}/><span>启用备份</span></label>}</div>
    {value&&<>
      <div className="audio-backup-fields"><div className="audio-backup-row"><label htmlFor={directoryId}>{isTauri()?'备份目录':'服务端备份目录'}</label><div className="audio-backup-directory"><input id={directoryId} aria-label="备份目录" value={value.directory} disabled={!value.enabled||busy} readOnly={isTauri()} placeholder="选择用于保存音频的文件夹" onChange={event=>edit({directory:event.target.value})}/>{isTauri()&&<Button type="button" disabled={!value.enabled||busy} onClick={()=>void choose()}>选择文件夹</Button>}</div></div>
      <div className="audio-backup-row"><span>自动清理</span><Select label="音频备份自动清理" disabled={!value.enabled||busy} value={String(value.retentionDays)} onChange={retentionDays=>edit({retentionDays:Number(retentionDays)})} options={[{value:'0',label:'永不清理'},...[7,30,90,180].map(days=>({value:String(days),label:`${days} 天后`}))]}/></div>
      </div>
      <Toast message={saved?'音频备份设置已保存':''} dismiss={()=>setSaved(false)}/>
      {value.error&&<FeedbackNotice message="部分音频备份未完成，请检查目录或磁盘。应用内原音会保留至备份成功或会议到期。" warning/>}
      {dirty&&<div className="audio-backup-actions">{actions}</div>}</>}
    {error&&<FeedbackNotice key={error} message={error} error/>}
  </section>;
}

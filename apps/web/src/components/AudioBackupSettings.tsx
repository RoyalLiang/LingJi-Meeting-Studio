import {useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {isTauri,invoke} from '@tauri-apps/api/core';
import {FolderOpen} from '@phosphor-icons/react';
import {api,messageOf} from '../api';
import {Button} from './ui';
import {Select} from './Select';
import {FeedbackNotice} from './FeedbackNotice';

type Settings={enabled:boolean;directory:string;retentionDays:number;error?:string};
export function AudioBackupSettings({actionsTarget}:{actionsTarget?:HTMLElement|null}){
  const [value,setValue]=useState<Settings|null>(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  useEffect(()=>{const controller=new AbortController();api<Settings>('/settings/audio-backup','GET',undefined,controller.signal).then(setValue).catch(error=>{if(!controller.signal.aborted)setError(messageOf(error));});return()=>controller.abort();},[]);
  const edit=(patch:Partial<Settings>)=>{setValue(current=>current?{...current,...patch}:current);setDirty(true);setSaved(false);};
  const choose=async()=>{try{const directory=await invoke<string|null>('audio_backup_directory',{initial:value?.directory||null});if(directory)edit({directory});}catch(error){setError(messageOf(error));}};
  const save=async()=>{if(!value||busy)return;setBusy(true);setError('');try{const next=await api<Settings>('/settings/audio-backup','PUT',value);setValue(next);setDirty(false);setSaved(true);}catch(error){setError(messageOf(error));}finally{setBusy(false);}};
  const actions=<Button disabled={!dirty||busy||!value||value.enabled&&!value.directory.trim()} onClick={()=>void save()}>{busy?'正在保存…':'保存音频备份'}</Button>;
  return <section className="settings-section audio-backup-settings"><div className="section-title"><FolderOpen size={19}/><h3>原始音频备份</h3></div>
    {value&&<><label className="checkbox-label"><input type="checkbox" checked={value.enabled} onChange={event=>edit({enabled:event.target.checked})}/><span>按会议保存录制音频 WAV 文件</span></label>
      <div className="audio-backup-fields"><label>{isTauri()?'备份目录':'服务端备份目录'}<div className="audio-backup-directory"><input aria-label="备份目录" value={value.directory} disabled={!value.enabled} readOnly={isTauri()} placeholder="选择用于保存音频的文件夹" onChange={event=>edit({directory:event.target.value})}/>{isTauri()&&<Button disabled={!value.enabled||busy} onClick={()=>void choose()}>选择文件夹</Button>}</div></label>
      <label>自动清理<Select label="音频备份自动清理" disabled={!value.enabled} value={String(value.retentionDays)} onChange={retentionDays=>edit({retentionDays:Number(retentionDays)})} options={[{value:'0',label:'永不清理'},...[7,30,90,180].map(days=>({value:String(days),label:`${days} 天后`}))]}/></label></div>
      <p className="audio-backup-hint">对新录音生效；仅清理本应用创建的备份，会议内的录音留存单独管理。</p>{saved&&<p className="audio-backup-saved" role="status">音频备份设置已保存</p>}
      {value.error&&<FeedbackNotice message="部分音频备份未完成，请检查目录或磁盘。应用内原音会保留至备份成功或会议到期。" warning/>}
      {dirty&&(actionsTarget?createPortal(actions,actionsTarget):actions)}</>}
    {error&&<FeedbackNotice key={error} message={error} error/>}
  </section>;
}

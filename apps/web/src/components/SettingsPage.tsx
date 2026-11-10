import { Brand } from './Brand';
import { ModuleConnectionCheck } from './ModuleConnectionCheck';
import { api } from '../api';
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { ArrowLeft, Translate, WarningCircle } from '@phosphor-icons/react';
import type { Bootstrap, RecordDetail } from '../model';
import type { useClientUpdates } from '../useClientUpdates';
import { ProviderSettings } from './ProviderSettings';
import { VocabularySettings } from './VocabularySettings';
import { DeviceSettings } from './DeviceSettings';
import { TranslationSettings } from './TranslationSettings';
import { ClientUpdatesPanel, ClientVersion } from './ClientUpdates';
import { Select } from './Select';
import { Button } from './ui';
const AudioBackupSettings=lazy(()=>import('./AudioBackupSettings').then(module=>({default:module.AudioBackupSettings})));
type Props={openContext:()=>void;close:()=>void;boot:Bootstrap;record:RecordDetail|null;recording:boolean;busy:boolean;updates:ReturnType<typeof useClientUpdates>;saved:(state:Pick<Bootstrap,'providers'|'meetingAutomation'|'audioMinutesDefault'>)=>void;language:(value:string)=>Promise<void>;translated:(value:string)=>void;diagnostics:()=>void;backup:()=>void};
export function SettingsPage({openContext,close,boot,record,recording,busy,updates,saved,language,translated,diagnostics,backup}:Props) {
  const [tab,setTab]=useState('models'),[actions,setActions]=useState<HTMLDivElement|null>(null);
  const backupSave=useRef<(()=>Promise<void>)|null>(null);
  const registerBackup=useCallback((save:(()=>Promise<void>)|null)=>{backupSave.current=save;},[]);
  const saveBackup=useCallback(()=>backupSave.current?.(),[]);
  const tabs=[['models','模型与转录'],['audio','音频与原音'],['vocabulary','词表与翻译'],['updates','更新与诊断']];
  return <section className="settings-page" aria-label="设置与诊断" onKeyDown={event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open],[role=listbox]:popover-open,[role=menu]:popover-open')){event.preventDefault();close();}}}><header className="surface-heading"><Button variant="ghost" className="settings-back" aria-label="返回工作台" onClick={close}><Brand markOnly/></Button><div><h1>{tabs.find(item=>item[0]===tab)?.[1]}</h1></div><div className="surface-actions"><Button className="context-toggle" onClick={openContext}>配置与使用</Button><div className="settings-action-slot" ref={setActions}/></div></header>
    <nav className="surface-tabs" aria-label="设置分类">{tabs.map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    <div className="settings-pages"><div hidden={tab!=='models'}>{boot.canConfigure?<ProviderSettings saved={saved} actionsTarget={tab==='models'?actions:null} beforeSave={saveBackup} initialProvider={boot.providers.asrProvider==='doubao-audio-only'?undefined:boot.providers.asrProvider} initialMinutesMode={boot.providers.minutesMode}/>:<p className="muted">当前账户无权修改模型配置。</p>}</div>
      <div hidden={tab!=='audio'}><DeviceSettings disabled={recording}/>{boot.canConfigure&&<Suspense fallback={<p role="status">正在加载音频设置…</p>}><AudioBackupSettings registerSave={registerBackup} actionsTarget={tab==='audio'?actions:null}/></Suspense>}{record&&<Button onClick={backup} disabled={busy}>备份待传音频</Button>}</div>
      <div hidden={tab!=='vocabulary'}><VocabularySettings actionsTarget={tab==='vocabulary'?actions:null}/>{record&&<><section className="settings-section settings-inline"><div className="section-title"><Translate size={19}/><h3>识别语言</h3></div><Select label="当前记录识别语言" readOnly={boot.providers.asrProvider==='sensevoice-local'||busy||['recording','sealed'].includes(record.capture)||record.pendingChunks>0} value={boot.providers.asrProvider==='sensevoice-local'?'auto':record.language} onChange={value=>void language(value)} options={boot.providers.asrProvider==='sensevoice-local'?[{value:'auto',label:'自动识别 · 中英日韩粤'}]:[{value:'auto',label:'自动识别'},{value:'zh',label:'中文'},{value:'en',label:'English'},{value:'ja',label:'日本語'},{value:'ko',label:'한국어'},{value:'yue',label:'粤语'}]}/></section><TranslationSettings key={record.id} recordId={record.id} value={record.translationTarget||''} saved={translated}/></>}</div>
      <div hidden={tab!=='updates'}><section className="settings-section"><div className="section-title"><h3>客户端更新</h3><ClientVersion updates={updates}/></div><ClientUpdatesPanel updates={updates}/>{!updates.native&&<p className="muted">浏览器版本随服务更新；安装版可在此管理更新。</p>}</section><section className="settings-section"><h3>诊断信息</h3><ModuleConnectionCheck label="记录存储服务" revision="record-storage" check={async signal=>{await api('/health','GET',undefined,signal);return '记录服务与存储可访问。';}}/><Button onClick={diagnostics}>导出诊断信息</Button></section></div>
    </div></section>;
}

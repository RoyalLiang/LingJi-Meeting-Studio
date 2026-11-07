import {FeedbackNotice} from './FeedbackNotice';
import { useState } from 'react';
import { version } from '../../../../package.json';
import type { UpdateStatus } from '../client-updates';
import { ArrowUp, ArrowsClockwise, DownloadSimple } from '@phosphor-icons/react';
import type { useClientUpdates } from '../useClientUpdates';
import { Button, Modal } from './ui';
import { Select } from './Select';
import { preferencesForPolicy, updatePolicy, updateReleaseItems, updateDownloadProgress } from '../client-updates';

export function ClientUpdatesPanel({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  const [notesOpen,setNotesOpen]=useState(false);
  if (!updates.native) return null;
  const { status, settings, installReason, saveSettings } = updates;
  const items = updateReleaseItems(status.notes), progress = updateDownloadProgress(status);
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const description: Record<string, string> = { idle: '', disabled: '此安装包尚未配置可信更新源，请使用手动安装包', checking: '正在检查更新…',
    current: '', available: '', downloading: progress.complete ? '下载完成，正在校验更新…' : '正在下载更新…', ready: status.installer ? '安装包已下载并完成完整性校验' : '更新已下载并通过验签',
    preparing: '正在确认录音与补传已安全结束…', installing: '正在安装，即将重新启动', error: '检查更新未完成，可稍后重试' };
  return <section className="settings-section client-updates" aria-label="版本更新">
    <div className="client-update-heading">
      <div className="section-title"><ArrowsClockwise size={19}/><h3>版本更新</h3></div>

      <div className="client-update-policy">
        <Select label="更新策略" value={updatePolicy(settings)} disabled={busy} onChange={value => saveSettings(preferencesForPolicy(value))} options={[
          {value:'manual',label:'手动检查'}, {value:'check',label:'自动检查'}, {value:'background',label:'自动检查并后台下载'}
        ]}/><ClientUpdateActions updates={updates}/>
      </div>
    </div>
    <div className="client-update-activity"><div className="client-update-status" role="status" aria-live="polite"><strong>{status.phase === 'current' ? '已是最新版本' : status.phase === 'available' ? `发现新版本 v${status.version}` : description[status.phase] || `当前版本 v${status.currentVersion || version}`}</strong>{status.phase === 'ready' && installReason && <span>{installReason}</span>}</div>
    {<div className="update-download" hidden={status.phase !== 'downloading'}>
      <div className="update-download-meta"><span>{progress.size}</span><span>{progress.percent === null ? '大小待确认' : `${progress.percent}%`}</span></div>
      <div className={`update-download-track${progress.percent === null ? ' is-indeterminate' : ''}`} role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined} aria-valuetext={progress.size}>
        <span style={{width:progress.percent === null ? '30%' : `${progress.percent}%`}}/>
      </div>
    </div>}
    {status.error && <FeedbackNotice key={status.error} message={status.error} error/>}
    </div>
    <Button type="button" variant="ghost" disabled={!items.length} className="update-notes-trigger" aria-haspopup="dialog" onClick={()=>setNotesOpen(true)}>更新内容</Button>
    {notesOpen && <Modal className="update-notes-modal" title="更新内容" onClose={()=>setNotesOpen(false)}><ul className="update-notes-list">{items.map((item,index)=><li key={index}>{item}</li>)}</ul></Modal>}
  </section>;
}

export function ClientUpdateActions({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  if (!updates.native) return null;
  const { status, installReason } = updates;
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const ready = status.phase === 'ready', available = status.phase === 'available';
  return <div className="actions"><Button disabled={busy || status.phase === 'disabled'} onClick={() => void updates.check()}><ArrowsClockwise size={17}/>{status.phase === 'checking' ? '正在检查…' : '检查更新'}</Button><Button disabled={busy || (ready ? Boolean(installReason) : !available)} title={ready ? installReason || '使用已校验的更新安装包' : undefined} onClick={() => void (ready ? updates.install() : updates.download())}><DownloadSimple size={17}/>{ready ? '安装并重启' : '下载更新'}</Button></div>;
}

export function ClientVersion({ status }: { status: UpdateStatus }) {
  const currentVersion = status.currentVersion || version;
  return <span className="client-update-version">v{currentVersion}{status.version && status.version !== currentVersion && <span className="client-update-available" role="img" aria-label={`可升级至 v${status.version}`} title={`可升级至 v${status.version}`}><ArrowUp size={10} weight="bold" aria-hidden="true"/></span>}</span>;
}

import { ArrowsClockwise, DownloadSimple } from '@phosphor-icons/react';
import type { useClientUpdates } from '../useClientUpdates';
import { Button } from './ui';
import { Select } from './Select';
import { preferencesForPolicy, updatePolicy, updateReleaseItems, updateDownloadProgress } from '../client-updates';

export function ClientUpdatesPanel({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  if (!updates.native) return null;
  const { status, settings, installReason, saveSettings } = updates;
  const items = updateReleaseItems(status.notes), progress = updateDownloadProgress(status);
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const description: Record<string, string> = { idle: settings.autoCheck ? '启动后会自动检查更新' : '由你手动检查更新', disabled: '此安装包尚未配置可信更新源，请使用手动安装包', checking: '正在检查更新…',
    current: '当前已是最新版本', available: `发现新版本 ${status.version || ''}`, downloading: progress.complete ? '下载完成，正在校验更新…' : '正在下载更新…', ready: status.installer ? '安装包已下载并完成完整性校验' : '更新已下载并通过验签',
    preparing: '正在确认录音与补传已安全结束…', installing: '正在安装，即将重新启动', error: '检查更新未完成，可稍后重试' };
  return <section className="settings-section client-updates" aria-label="版本更新">
    <div className="client-update-heading">
      <div className="section-title"><ArrowsClockwise size={19}/><h3>版本更新</h3></div>
      <span className="client-update-version">v{status.currentVersion || '读取中'}</span>
      <div className="client-update-policy">
        <Select label="更新策略" value={updatePolicy(settings)} disabled={busy} onChange={value => saveSettings(preferencesForPolicy(value))} options={[
          {value:'manual',label:'手动检查'}, {value:'check',label:'自动检查'}, {value:'background',label:'自动检查并后台下载'}
        ]}/><ClientUpdateActions updates={updates}/>
      </div>
    </div>
    <p className="client-update-status" role="status">{description[status.phase] || '更新状态待确认'}</p>
    {status.phase === 'downloading' && <div className="update-download">
      <div className="update-download-meta"><span>{progress.size}</span><span>{progress.percent === null ? '大小待确认' : `${progress.percent}%`}</span></div>
      <div className={`update-download-track${progress.percent === null ? ' is-indeterminate' : ''}`} role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined} aria-valuetext={progress.size}>
        <span style={{width:progress.percent === null ? '30%' : `${progress.percent}%`}}/>
      </div>
    </div>}
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    {status.phase === 'ready' && installReason && <p className="fine-print" role="status">{installReason}</p>}
    {items.length > 0 && <div className="update-notes" aria-label="版本更新内容"><h4>更新内容</h4><ul>{items.map((item,index) => <li key={index}>{item}</li>)}</ul></div>}
  </section>;
}

export function ClientUpdateActions({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  if (!updates.native) return null;
  const { status, settings, installReason } = updates;
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const ready = status.phase === 'ready', background = updatePolicy(settings) === 'background';
  return <div className="actions"><Button disabled={busy || status.phase === 'disabled' || (background && !ready) || (ready && Boolean(installReason))}
    title={ready ? installReason || '使用已校验的更新安装包' : background ? '下载并校验完成后可更新' : '检查并下载更新，校验完成后继续安装'} onClick={() => void updates.update()}><DownloadSimple size={17}/>{ready || background ? '立即更新' : '下载并更新'}</Button></div>;
}

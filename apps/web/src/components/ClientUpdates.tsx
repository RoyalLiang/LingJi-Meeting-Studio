import { DownloadSimple } from '@phosphor-icons/react';
import type { useClientUpdates } from '../useClientUpdates';
import { Button } from './ui';
import { Select } from './Select';
import { preferencesForPolicy, updatePolicy } from '../client-updates';

export function ClientUpdatesPanel({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  if (!updates.native) return null;
  const { status, settings, installReason, saveSettings } = updates;
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const description: Record<string, string> = { idle: settings.autoCheck ? '启动后会自动检查更新' : '由你手动检查更新', disabled: '此安装包尚未配置可信更新源，请使用手动安装包', checking: '正在检查更新…',
    current: '当前已是最新版本', available: `发现新版本 ${status.version || ''}`, downloading: '正在下载并校验更新…', ready: status.installer ? '安装包已下载并完成完整性校验' : '更新已下载并通过验签',
    preparing: '正在确认录音与补传已安全结束…', installing: '正在安装，即将重新启动', error: '检查更新未完成，可稍后重试' };
  return <section className="settings-section" aria-label="客户端更新"><h3>客户端更新</h3>
    <p role="status">版本 {status.currentVersion || '读取中'} · {description[status.phase] || '更新状态待确认'}</p>
    {status.phase === 'downloading' && <progress aria-label="更新下载进度" value={status.total ? status.downloaded : undefined} max={status.total || 1}/>}
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    {status.notes && <details className="update-notes"><summary>版本更新内容</summary><p style={{ whiteSpace: 'pre-line' }}>{status.notes}</p></details>}
    <div className="field client-update-policy"><span>更新策略</span><Select label="更新策略" value={updatePolicy(settings)} disabled={busy} onChange={value => saveSettings(preferencesForPolicy(value))} options={[
      { value: 'manual', label: '手动检查' }, { value: 'check', label: '自动检查' }, { value: 'background', label: '自动检查并后台下载' },
    ]}/><ClientUpdateActions updates={updates}/></div>
    {status.phase === 'ready' && installReason && <p className="fine-print" role="status">{installReason}</p>}
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

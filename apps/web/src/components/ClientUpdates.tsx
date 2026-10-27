import { DownloadSimple, ArrowsClockwise } from '@phosphor-icons/react';
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
    <div className="field"><span>更新策略</span><Select label="更新策略" value={updatePolicy(settings)} disabled={busy} onChange={value => saveSettings(preferencesForPolicy(value))} options={[
      { value: 'manual', label: '手动检查' }, { value: 'check', label: '自动检查' }, { value: 'background', label: '自动检查并后台下载' },
    ]}/></div>
    {status.phase === 'ready' && installReason && <p className="fine-print" role="status">{installReason}</p>}
  </section>;
}

export function ClientUpdateActions({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  if (!updates.native) return null;
  const { status, installReason } = updates;
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  return <div className="actions"><Button disabled={busy || status.phase === 'disabled'} onClick={() => void updates.check()}><ArrowsClockwise size={17}/>检查更新</Button>
      {status.phase === 'available' && <Button disabled={busy} onClick={() => void updates.download()}><DownloadSimple size={17}/>下载更新</Button>}
      <Button variant="primary" disabled={busy || status.phase !== 'ready' || Boolean(installReason)} title={status.phase === 'ready' ? installReason || (status.installer ? '打开已校验安装包，由系统安装器继续' : '安装已验签更新并重新启动') : status.phase === 'disabled' ? '此安装包未配置更新源' : (status.installer ? '下载并完成完整性校验后可打开安装包' : '更新下载并验签后可重启安装')} onClick={() => void updates.install()}>{status.installer ? '打开安装包' : '重启更新'}</Button></div>;
}

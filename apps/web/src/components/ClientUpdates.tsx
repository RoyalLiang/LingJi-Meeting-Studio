import { DownloadSimple, ArrowsClockwise } from '@phosphor-icons/react';
import type { useClientUpdates } from '../useClientUpdates';
import { Button } from './ui';

export function ClientUpdatesPanel({ updates }: { updates: ReturnType<typeof useClientUpdates> }) {
  if (!updates.native) return null;
  const { status, settings, saveSettings } = updates;
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(status.phase);
  const description: Record<string, string> = { idle: '启动后会自动检查更新', disabled: '此安装包尚未配置可信更新源，请使用手动安装包', checking: '正在检查更新…',
    current: '当前已是最新版本', available: `发现新版本 ${status.version || ''}`, downloading: '正在下载并验证更新签名…', ready: '更新已下载并通过验签',
    preparing: '正在确认录音与补传已安全结束…', installing: '正在安装，即将重新启动', error: '检查更新未完成，可稍后重试' };
  return <section className="settings-section" aria-label="客户端更新"><h3>客户端更新</h3>
    <p role="status">版本 {status.currentVersion || '读取中'} · {description[status.phase] || '更新状态待确认'}</p>
    {status.phase === 'downloading' && <progress aria-label="更新下载进度" value={status.total ? status.downloaded : undefined} max={status.total || 1}/>}
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    {status.notes && <p className="fine-print" style={{ whiteSpace: 'pre-line' }}>{status.notes}</p>}
    <label className="checkbox-label"><input type="checkbox" checked={settings.autoCheck} onChange={event => saveSettings({ ...settings, autoCheck: event.target.checked })}/>自动检查更新</label>
    <label className="checkbox-label"><input type="checkbox" checked={settings.autoDownload} onChange={event => saveSettings({ ...settings, autoDownload: event.target.checked })}/>自动下载更新</label>
    <label className="checkbox-label"><input type="checkbox" checked={settings.autoInstall} onChange={event => saveSettings({ ...settings, autoInstall: event.target.checked })}/>会议结束且补传完成后自动安装并重启</label>
    <p className="fine-print">录音中、暂停待继续或有待传音频时均不安装。更新可能重新启动客户端；会议内容和离线队列保留。自动下载会使用网络流量。</p>
    <div className="actions"><Button disabled={busy || status.phase === 'disabled'} onClick={() => void updates.check()}><ArrowsClockwise size={17}/>检查更新</Button>
      {status.phase === 'available' && <Button disabled={busy} onClick={() => void updates.download()}><DownloadSimple size={17}/>下载更新</Button>}
      {status.phase === 'ready' && <Button variant="primary" disabled={busy} onClick={() => void updates.install()}>安装并重启</Button>}</div>
  </section>;
}

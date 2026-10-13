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
    current: '当前已是最新版本', available: `发现新版本 ${status.version || ''}`, downloading: '正在下载并验证更新签名…', ready: '更新已下载并通过验签',
    preparing: '正在确认录音与补传已安全结束…', installing: '正在安装，即将重新启动', error: '检查更新未完成，可稍后重试' };
  return <section className="settings-section" aria-label="客户端更新"><h3>客户端更新</h3>
    <p role="status">版本 {status.currentVersion || '读取中'} · {description[status.phase] || '更新状态待确认'}</p>
    {status.phase === 'downloading' && <progress aria-label="更新下载进度" value={status.total ? status.downloaded : undefined} max={status.total || 1}/>}
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    {status.notes && <p className="fine-print" style={{ whiteSpace: 'pre-line' }}>{status.notes}</p>}
    <div className="field"><span>更新策略</span><Select label="更新策略" value={updatePolicy(settings)} disabled={busy} onChange={value => saveSettings(preferencesForPolicy(value))} options={[
      { value: 'manual', label: '手动检查' }, { value: 'check', label: '自动检查' }, { value: 'background', label: '自动检查并后台下载' },
    ]}/></div>
    <p className="fine-print">{settings.autoDownload ? '发现更新后会在后台下载并验签，可能使用网络流量。' : settings.autoCheck ? '自动发现新版本，由你选择何时下载。' : '点击“检查更新”发现新版本，再选择下载。'} 安装与重启始终由你确认。</p>
    <p className="fine-print">录音中、暂停待继续或有待传音频时均不安装。会议内容和离线队列保留。</p>
    <div className="actions"><Button disabled={busy || status.phase === 'disabled'} onClick={() => void updates.check()}><ArrowsClockwise size={17}/>检查更新</Button>
      {status.phase === 'available' && <Button disabled={busy} onClick={() => void updates.download()}><DownloadSimple size={17}/>下载更新</Button>}
      <Button variant="primary" disabled={busy || status.phase !== 'ready' || Boolean(installReason)} title={status.phase === 'ready' ? installReason || '安装已验签更新并重新启动' : status.phase === 'disabled' ? description.disabled : '更新下载并验签后可重启安装'} onClick={() => void updates.install()}>重启更新</Button></div>
    {status.phase === 'ready' && installReason && <p className="fine-print" role="status">{installReason}</p>}
  </section>;
}

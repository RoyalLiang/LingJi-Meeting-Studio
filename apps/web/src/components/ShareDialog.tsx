import { useEffect, useRef, useState } from 'react';
import { Check, Copy, DownloadSimple, LinkSimple, ShareNetwork } from '@phosphor-icons/react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RecordDetail } from '../model';
import { api, messageOf } from '../api';
import { canCreateShareLinks, createShareDocument, minutesForShare, shareFilename } from '../share-content';
import { Button, Modal } from './ui';
import './ShareDialog.css';

interface ShareLink { id: string; scope: string; expires: number; revoked: boolean }

export function ShareDialog({ record, localAccount, close, notify }: { record: RecordDetail; localAccount: boolean; close: () => void; notify: (message: string) => void }) {
  const linksAvailable = canCreateShareLinks(localAccount, location.origin);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [url, setUrl] = useState('');
  const [links, setLinks] = useState<ShareLink[]>([]), [prepared, setPrepared] = useState<{ url: string; name: string } | null>(null);
  const request = useRef(false), mounted = useRef(true);
  const native = isTauri(), [downloadReady, setDownloadReady] = useState(!native), [downloading, setDownloading] = useState(false);
  const downloadUrl = useRef(''), downloadTimer = useRef<number | undefined>(undefined), latestNotify = useRef(notify); latestNotify.current = notify;
  useEffect(() => {
    if (!native) return;
    let active = true, stop: (() => void) | undefined;
    void listen<{ url: string; success: boolean }>('client-download-finished', event => {
      if (!active || event.payload.url !== downloadUrl.current) return;
      downloadUrl.current = ''; clearTimeout(downloadTimer.current); setDownloading(false);
      if (event.payload.success) latestNotify.current('分享文件已保存至下载文件夹。');
      else setError('下载未完成，请点击重新下载。');
    }).then(unlisten => { if (active) { stop = unlisten; setDownloadReady(true); } else unlisten(); }).catch(() => { if (active) setError('暂无法接收下载结果，请重开分享窗口。'); });
    return () => { active = false; stop?.(); clearTimeout(downloadTimer.current); };
  }, [native]);
  useEffect(() => {
    mounted.current = true;
    if (!linksAvailable) return () => { mounted.current = false; };
    const controller = new AbortController();
    void api<{ shares: ShareLink[] }>(`/records/${record.id}/shares`, 'GET', undefined, controller.signal).then(result => setLinks(result.shares)).catch(error => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => { mounted.current = false; controller.abort(); };
  }, [record.id, linksAvailable]);
  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.url); }, [prepared]);
  const minutes = minutesForShare(record), hasContent = Boolean(minutes);
  const activeLinks = links.filter(link => !link.revoked && link.expires > Date.now());
  async function generateLink() {
    if (request.current) return;
    request.current = true; setBusy(true); setError('');
    try {
      const share = await api<{ token: string; id: string; scope: string; expires: number }>(`/records/${record.id}/shares`, 'POST', { scope:'minutes' });
      if (!mounted.current) return;
      setUrl(`${location.origin}/share/${share.token}`); setLinks(current => [...current, { ...share, revoked: false }]);
    } catch (error) { if (mounted.current) setError(messageOf(error)); }
    finally { request.current = false; if (mounted.current) setBusy(false); }
  }
  function exportFile() {
    setError('');
    try {
      const file = { url: URL.createObjectURL(new Blob([createShareDocument(record)], { type: 'text/html;charset=utf-8' })), name: shareFilename(record.title) };
      setPrepared(file);
      beginDownload(file.url);
      const link = document.createElement('a'); link.href = file.url; link.download = file.name; document.body.append(link); link.click(); link.remove();
      notify('已开始下载分享文件。');
    } catch (error) { setError(messageOf(error)); }
  }
  function beginDownload(url: string) {
    if (!native) return;
    downloadUrl.current = url; setDownloading(true); clearTimeout(downloadTimer.current);
    downloadTimer.current = window.setTimeout(() => { downloadUrl.current = ''; setDownloading(false); setError('未收到下载完成结果，可点击重新下载。'); }, 30_000);
  }
  return <Modal title="分享会议" onClose={close}>
    <div className="meeting-share">
      <div className="meeting-share-intro"><span className="meeting-share-icon"><ShareNetwork size={24}/></span><h3>{record.title}</h3></div>
      {minutes && <section className="meeting-share-preview" aria-label="分享预览"><h4>{minutes.title}</h4>{(minutes.highlights?.length ? minutes.highlights : minutes.sections.flatMap(section=>section.items)).slice(0,3).map((item,index)=><p key={index}>{item.text}</p>)}</section>}
      {!hasContent && <p className="meeting-share-empty" role="status">有会议内容后即可分享。</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="actions meeting-share-actions">{linksAvailable ? <Button variant="primary" disabled={busy || !hasContent} onClick={() => void generateLink()}><LinkSimple size={18}/>{busy ? '正在生成…' : '生成分享链接'}</Button> : <Button variant="primary" disabled={!hasContent || !downloadReady || downloading} onClick={exportFile}><DownloadSimple size={18}/>{downloading ? '正在保存…' : '导出分享文件'}</Button>}{prepared && !downloading && <a className="meeting-share-retry" href={prepared.url} download={prepared.name} onClick={() => { setError(''); beginDownload(prepared.url); }}>重新下载</a>}</div>
      {url && <div className="meeting-share-link"><label>只读链接<input readOnly value={url} onFocus={event => event.currentTarget.select()}/></label><Button aria-label="复制分享链接" onClick={async () => { setError(''); try { await navigator.clipboard.writeText(url); notify('分享链接已复制。'); } catch { setError('复制未成功，请选中链接手动复制。'); } }}><Copy size={18}/>复制</Button></div>}
      {activeLinks.length > 0 && <section className="meeting-share-existing"><h3><Check size={16}/>有效链接</h3>{activeLinks.map(link => <div className="meeting-share-row" key={link.id}><span>会议纪要<small>{new Date(link.expires).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期</small></span><Button variant="ghost" disabled={busy} onClick={async () => {
        if (request.current) return; request.current = true; setBusy(true); setError('');
        try { await api(`/records/${record.id}/shares/${link.id}`, 'DELETE'); if (mounted.current) { setLinks(current => current.map(value => value.id === link.id ? { ...value, revoked: true } : value)); setUrl(''); notify('分享链接已撤销。'); } }
        catch (error) { if (mounted.current) setError(messageOf(error)); }
        finally { request.current = false; if (mounted.current) setBusy(false); }
      }}>撤销</Button></div>)}</section>}
    </div>
  </Modal>;
}

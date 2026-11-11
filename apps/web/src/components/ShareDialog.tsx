import {FeedbackNotice} from './FeedbackNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, DownloadSimple, LinkSimple, ShareNetwork } from '@phosphor-icons/react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RecordDetail } from '../model';
import { api, messageOf } from '../api';
import { createShareDocument, minutesForShare, shareFilename } from '../share-content';
import { Button, Modal } from './ui';
import { Select } from './Select';
import { createPublishedContent, MAX_PUBLISHED_BYTES } from '../../../../packages/records/src/published-content.mjs';
import { shareFingerprint } from '../../../../packages/records/src/encrypted-share.mjs';
import type { ShareScope } from '../share-content';
import './ShareDialog.css';

interface ShareLink { id: string; scope: ShareScope; expires: number; revoked: boolean; pending?: boolean; url?: string; requestId: string; fingerprint: string }
interface LegacyLink { id: string; scope: string; expires: number; revoked: boolean }

export function ShareDialog({ record, close, notify }: { record: RecordDetail; localAccount: boolean; close: () => void; notify: (message: string) => void }) {
  const [scope, setScope] = useState<ShareScope>('minutes');
  const [confirmed, setConfirmed] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [legacyLinks, setLegacyLinks] = useState<LegacyLink[]>([]);
  const attempt = useRef<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [url, setUrl] = useState('');
  const [links, setLinks] = useState<ShareLink[]>([]), [prepared, setPrepared] = useState<{ url: string; name: string } | null>(null);
  const request = useRef(false), mounted = useRef(true);
  const native = isTauri(), [downloadReady, setDownloadReady] = useState(!native), [downloading, setDownloading] = useState(false);
  const downloadUrl = useRef(''), downloadTimer = useRef<number | undefined>(undefined), latestNotify = useRef(notify); latestNotify.current = notify;
  const preview = useMemo(() => {
    try { const content = createPublishedContent(record, scope); return { content, text: JSON.stringify(content), html: createShareDocument(record, scope, true) }; }
    catch { return null; }
  }, [record, scope]);
  useEffect(() => {
    let active = true; setConfirmed(false); setFingerprint(''); attempt.current = null;
    if (preview) void shareFingerprint(preview.content).then(value => { if (active) setFingerprint(value); }).catch(() => { if (active) setError('所选内容超过加密分享限额或格式不完整，请缩小范围或导出 HTML。'); });
    return () => { active = false; };
    // Only changes to shared content invalidate confirmation, not unrelated progress events.
  }, [preview?.text]);
  useEffect(() => {
    if (!native) return;
    let active = true, stop: (() => void) | undefined;
    void listen<{ url: string; success: boolean }>('client-download-finished', event => {
      if (!active || event.payload.url !== downloadUrl.current) return;
      downloadUrl.current = ''; clearTimeout(downloadTimer.current); setDownloading(false);
      if (event.payload.success) latestNotify.current('分享文件已保存至下载文件夹。');
      else setError('下载未完成，请再次点击导出。');
    }).then(unlisten => { if (active) { stop = unlisten; setDownloadReady(true); } else unlisten(); }).catch(() => { if (active) setError('暂无法接收下载结果，请重开分享窗口。'); });
    return () => { active = false; stop?.(); clearTimeout(downloadTimer.current); };
  }, [native]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void Promise.allSettled([
      api<{ shares: ShareLink[] }>(`/records/${record.id}/encrypted-shares`, 'GET', undefined, controller.signal),
      api<{ shares: LegacyLink[] }>(`/records/${record.id}/shares`, 'GET', undefined, controller.signal)
    ]).then(([encrypted, legacy]) => {
      if (controller.signal.aborted) return;
      if (encrypted.status === 'fulfilled') setLinks(encrypted.value.shares); else setError(messageOf(encrypted.reason));
      if (legacy.status === 'fulfilled') setLegacyLinks(legacy.value.shares); else setError(messageOf(legacy.reason));
    });
    return () => { mounted.current = false; controller.abort(); };
  }, [record.id]);
  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.url); }, [prepared]);
  const minutes = minutesForShare(record), hasContent = Boolean(minutes || (scope === 'full' && record.segments.length));
  const activeLinks = links.filter(link => !link.revoked && (link.pending || link.expires > Date.now()));
  async function generateLink(retry?: ShareLink) {
    if (request.current || !confirmed || !fingerprint) return;
    if (retry && retry.fingerprint !== fingerprint) { setError('旧快照与当前内容不同，请先撤销旧分享，再核对并创建新链接。'); return; }
    request.current = true; setBusy(true); setError('');
    try {
      if (!preview || await shareFingerprint(preview.content) !== fingerprint) { setConfirmed(false); throw new Error('会议内容已变化，请重新核对并确认。'); }
      attempt.current ||= crypto.randomUUID();
      const share = await api<ShareLink>(`/records/${record.id}/encrypted-shares`, 'POST', { scope: retry?.scope || scope, requestId: retry?.requestId || attempt.current, confirmed: true, fingerprint });
      if (!mounted.current) return;
      setUrl(share.url || ''); setLinks(current => [...current.filter(item => item.id !== share.id), share]); attempt.current = null; setConfirmed(false);
    } catch (error) { if (mounted.current) setError(messageOf(error)); }
    finally { request.current = false; if (mounted.current) setBusy(false); }
  }
  function exportFile(online = false) {
    setError('');
    try {
      const content = online ? JSON.stringify(createPublishedContent(record, scope)) : createShareDocument(record, scope, true);
      if (online && new TextEncoder().encode(content).length > MAX_PUBLISHED_BYTES - 1024) throw new Error('内容超过在线分享的 1 MiB 限额，请改选仅纪要或导出 HTML 文件。');
      const file = { url: URL.createObjectURL(new Blob([content], { type: online ? 'application/json;charset=utf-8' : 'text/html;charset=utf-8' })), name: shareFilename(record.title).replace(/\.html$/, online ? '.lingji.json' : '.html') };
      setPrepared(file);
      beginDownload(file.url);
      const link = document.createElement('a'); link.href = file.url; link.download = file.name; document.body.append(link); link.click(); link.remove();
      notify('已开始下载分享文件。');
    } catch (error) { setError(messageOf(error)); }
  }
  function beginDownload(url: string) {
    if (!native) return;
    downloadUrl.current = url; setDownloading(true); clearTimeout(downloadTimer.current);
    downloadTimer.current = window.setTimeout(() => { downloadUrl.current = ''; setDownloading(false); setError('未收到下载完成结果，可再次点击导出。'); }, 30_000);
  }
  return <Modal title="分享会议" onClose={close}>
    <div className="meeting-share">
      <div className="meeting-share-intro"><span className="meeting-share-icon"><ShareNetwork size={24}/></span><h3>{record.title}</h3></div>
      {minutes && <section className="meeting-share-preview" aria-label="分享预览"><h4>{minutes.title}</h4>{(minutes.highlights?.length ? minutes.highlights : minutes.sections.flatMap(section=>section.items)).slice(0,3).map((item,index)=><p key={index}>{item.text}</p>)}</section>}
      {!hasContent && <p className="meeting-share-empty" role="status">有会议内容后即可分享。</p>}
      {preview && <details className="meeting-share-full-preview"><summary>核对完整分享内容</summary><iframe title="完整分享预览" sandbox="" srcDoc={preview.html}/></details>}
      {error && <FeedbackNotice key={error} message={error} error/>}
      <section className="meeting-share-existing"><h3>加密链接分享</h3><label>分享范围<Select label="在线分享范围" value={scope} disabled={busy || downloading} onChange={value => { setScope(value as ShareScope); setConfirmed(false); attempt.current = null; setPrepared(null); }} options={[{value:'minutes',label:'仅纪要及引用原文'},{value:'full',label:'纪要与全部转录'}]}/></label><p className="meeting-share-empty">无需登录，在客户端加密后上传至官网。接收者用浏览器解密阅读，链接 24 小时有效。原音不会上传。</p><label className="meeting-share-consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)}/>我确认分享所选内容；持有完整链接的人可以阅读。</label><div className="actions meeting-share-actions"><Button variant="primary" disabled={busy || !hasContent || !confirmed || !fingerprint} onClick={() => void generateLink()}><LinkSimple size={18}/>{busy ? '正在生成…' : '生成加密分享链接'}</Button></div><p className="meeting-share-empty">删除本机会议不会自动撤销链接，请先在这里撤销。已被接收者保存的副本无法收回。</p></section>
      <div className="actions meeting-share-actions"><Button disabled={!hasContent || !downloadReady || downloading} onClick={() => exportFile()}><DownloadSimple size={18}/>{downloading ? '正在保存…' : '导出 HTML 分享文件'}</Button><Button disabled={!hasContent || !downloadReady || downloading} onClick={() => exportFile(true)}>导出明文备份</Button></div>
      {url && <div className="meeting-share-link"><label>只读链接<input readOnly value={url} onFocus={event => event.currentTarget.select()}/></label><Button aria-label="复制分享链接" onClick={async () => { setError(''); try { await navigator.clipboard.writeText(url); notify('分享链接已复制。'); } catch { setError('复制未成功，请选中链接手动复制。'); } }}><Copy size={18}/>复制</Button></div>}
      {activeLinks.length > 0 && <section className="meeting-share-existing"><h3><Check size={16}/>分享链接</h3>{activeLinks.map(link => <div className="meeting-share-row" key={link.id}><span>{link.scope === 'full' ? '纪要与全部转录' : '会议纪要'}<small>{link.pending ? '创建未完成，可重试原快照' : new Date(link.expires).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 到期'}</small></span>{link.pending ? <Button variant="ghost" disabled={busy || !confirmed} onClick={() => void generateLink(link)}>重试</Button> : <Button variant="ghost" disabled={busy} onClick={() => setUrl(link.url || '')}>查看链接</Button>}<Button variant="ghost" disabled={busy} onClick={async () => {
        if (request.current) return; request.current = true; setBusy(true); setError('');
        try { await api(`/records/${record.id}/encrypted-shares/${encodeURIComponent(link.id)}`, 'DELETE'); if (mounted.current) { setLinks(current => current.map(value => value.id === link.id ? { ...value, revoked: true } : value)); setUrl(''); notify('分享链接已撤销。'); } }
        catch (error) { if (mounted.current) setError(messageOf(error)); }
        finally { request.current = false; if (mounted.current) setBusy(false); }
      }}>撤销</Button></div>)}</section>}
      {legacyLinks.some(link => !link.revoked && link.expires > Date.now()) && <section className="meeting-share-existing"><h3>旧分享链接</h3><p className="meeting-share-empty">旧链接继续有效，可在这里撤销；新创建的链接使用加密分享。</p>{legacyLinks.filter(link => !link.revoked && link.expires > Date.now()).map(link => <div className="meeting-share-row" key={link.id}><span>旧版会议纪要<small>{new Date(link.expires).toLocaleString('zh-CN')} 到期</small></span><Button variant="ghost" disabled={busy} onClick={async () => {
        if (request.current) return; request.current = true; setBusy(true); setError('');
        try { await api(`/records/${record.id}/shares/${link.id}`, 'DELETE'); if (mounted.current) { setLegacyLinks(current => current.map(item => item.id === link.id ? {...item, revoked:true} : item)); notify('旧分享链接已撤销。'); } }
        catch (error) { if (mounted.current) setError(messageOf(error)); }
        finally { request.current = false; if (mounted.current) setBusy(false); }
      }}>撤销旧链接</Button></div>)}</section>}
    </div>
  </Modal>;
}

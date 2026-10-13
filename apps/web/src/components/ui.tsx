import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { fetchDownload } from '../downloads';
import { messageOf } from '../api';
import { Toast } from './Toast';
export function Button({ children, variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button ${variant} ${className}`} {...props}>{children}</button>;
}
export function Modal({ title, children, onClose, wide = false, explicitCloseOnly = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; explicitCloseOnly?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal glass ${wide ? 'wide' : ''}`} ref={ref} onCancel={event => { event.preventDefault(); if (!explicitCloseOnly) onClose(); }} onClick={event => { if (!explicitCloseOnly && event.target === event.currentTarget) onClose(); }} aria-labelledby={titleId}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2><Button className="modal-close" variant="ghost" aria-label="关闭" onClick={onClose}><X size={20}/></Button></header><div className="modal-body">{children}</div>
  </dialog>;
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}
export function Status({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`status ${tone}`}>{children}</span>; }
export function Download({ href, children }: { href: string; children: ReactNode }) {
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [prepared,setPrepared] = useState<{url:string;filename:string}|null>(null), request = useRef<AbortController|null>(null);
  const dismiss = useCallback(() => setNotice(''), []);
  useEffect(() => { setPrepared(null); setError(''); setNotice(''); setBusy(false); return () => { request.current?.abort(); }; }, [href]);
  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.url); }, [prepared]);
  async function download() {
    const controller = new AbortController(); request.current = controller; setBusy(true); setPrepared(null); setError(''); setNotice('');
    try {
      const file = await fetchDownload(href, controller.signal); if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file.blob); setPrepared({url,filename:file.filename});
      const link = document.createElement('a'); link.href=url; link.download=file.filename; document.body.append(link); link.click(); link.remove();
      setNotice('文件已准备。若浏览器拦截下载，请点击“重新下载”。');
    } catch (error) { if (!controller.signal.aborted) setError(messageOf(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <span className="download-control"><Button disabled={busy} onClick={() => void download()}>{busy ? '正在准备…' : children}</Button>
    {prepared && <a className="download-retry" href={prepared.url} download={prepared.filename}>重新下载</a>}
    {error && <span className="download-error" role="alert">{error}</span>}<Toast message={notice} dismiss={dismiss}/>
  </span>;
}

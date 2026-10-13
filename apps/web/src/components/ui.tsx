import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { fetchDownload } from '../downloads';
import { messageOf } from '../api';
import { Toast } from './Toast';
import './CloseButton.css';
export function Button({ children, variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button ${variant} ${className}`} {...props}>{children}</button>;
}
export function CloseButton({ label = '关闭', className = '', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { label?: string }) {
  return <Button type="button" variant="ghost" className={`close-button ${className}`} aria-label={label} title={label} {...props}>
    <svg className="close-gear" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M24.66 11L25.61 13.24L28.72 13.3V18.7L25.61 18.76L24.66 21L23.19 22.95L24.7 25.66L20.02 28.36L18.42 25.7L16 26L13.58 25.7L11.98 28.36L7.3 25.66L8.81 22.95L7.34 21L6.39 18.76L3.28 18.7V13.3L6.39 13.24L7.34 11L8.81 9.05L7.3 6.34L11.98 3.64L13.58 6.3L16 6L18.42 6.3L20.02 3.64L24.7 6.34L23.19 9.05Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
    <X className="close-symbol" size={16} weight="bold" aria-hidden="true"/>
  </Button>;
}
export function Modal({ title, children, onClose, wide = false, explicitCloseOnly = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; explicitCloseOnly?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal glass ${wide ? 'wide' : ''}`} ref={ref} onCancel={event => { event.preventDefault(); if (!explicitCloseOnly) onClose(); }} onClick={event => { if (!explicitCloseOnly && event.target === event.currentTarget) onClose(); }} aria-labelledby={titleId}>
    <header className="modal-header"><h2 id={titleId}>{title}</h2><CloseButton className="modal-close" onClick={onClose}/></header><div className="modal-body">{children}</div>
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

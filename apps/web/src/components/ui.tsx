import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { fetchDownload } from '../downloads';
import { messageOf } from '../api';
import { Toast } from './Toast';
import './CloseButton.css';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export function Button({ children, variant = 'secondary', className = '', title, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const button=useRef<HTMLButtonElement>(null),tip=useRef<HTMLSpanElement>(null),id=useId();
  const label=title || props['aria-label'];
  useEffect(()=>{
    const anchor=button.current,popup=tip.current;if(!anchor||!popup)return;
    let timer:number|undefined;
    const hide=()=>{clearTimeout(timer);if(popup.matches(':popover-open'))popup.hidePopover();removeEventListener('scroll',hide,true);removeEventListener('resize',hide);document.removeEventListener('keydown',key,true);};
    const show=()=>{
      clearTimeout(timer);if(!anchor.isConnected)return;
      document.querySelectorAll<HTMLElement>('.button-tooltip:popover-open').forEach(other=>{if(other!==popup)other.hidePopover();});
      if(!popup.matches(':popover-open'))popup.showPopover();const a=anchor.getBoundingClientRect(),p=popup.getBoundingClientRect();
      const top=a.top-p.height-8;
      popup.style.left=`${Math.max(8,Math.min(innerWidth-p.width-8,a.left+(a.width-p.width)/2))}px`;
      popup.style.top=`${Math.max(8,Math.min(innerHeight-p.height-8,top>=8?top:a.bottom+8))}px`;
      addEventListener('scroll',hide,true);addEventListener('resize',hide);document.addEventListener('keydown',key,true);
      };
    const enter=()=>{timer=window.setTimeout(show,300);},key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&popup.matches(':popover-open')){hide();e.preventDefault();e.stopPropagation();}};
    const toggled=()=>{if(!popup.matches(':popover-open'))hide();};
    popup.addEventListener('toggle',toggled);
    anchor.addEventListener('pointerenter',enter);anchor.addEventListener('pointerleave',hide);
    anchor.addEventListener('focus',show);anchor.addEventListener('blur',hide);anchor.addEventListener('click',hide);
    return()=>{hide();popup.removeEventListener('toggle',toggled);anchor.removeEventListener('pointerenter',enter);anchor.removeEventListener('pointerleave',hide);anchor.removeEventListener('focus',show);anchor.removeEventListener('blur',hide);anchor.removeEventListener('click',hide);};
  },[label]);
  return <button className={`button ${variant} ${className}`} data-tooltip={label} {...props} ref={button} aria-describedby={[props['aria-describedby'],label?id:undefined].filter(Boolean).join(' ')||undefined}>{children}{label&&<span ref={tip} id={id} role="tooltip" popover="manual" className="button-tooltip">{label}</span>}</button>;
}
export function CloseButton({ label = '关闭', className = '', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { label?: string }) {
  return <Button type="button" variant="ghost" className={`close-button ${className}`} aria-label={label} title={label} {...props}>
    <svg className="close-gear" width="44" height="44" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M24.66 11L25.61 13.24L28.72 13.3V18.7L25.61 18.76L24.66 21L23.19 22.95L24.7 25.66L20.02 28.36L18.42 25.7L16 26L13.58 25.7L11.98 28.36L7.3 25.66L8.81 22.95L7.34 21L6.39 18.76L3.28 18.7V13.3L6.39 13.24L7.34 11L8.81 9.05L7.3 6.34L11.98 3.64L13.58 6.3L16 6L18.42 6.3L20.02 3.64L24.7 6.34L23.19 9.05Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>
    <X className="close-symbol" size={20} weight="bold" aria-hidden="true"/>
  </Button>;
}
export function Modal({ title, children, onClose, wide = false, explicitCloseOnly = false, initialFocus = 'heading', footer, headerActions, className = '' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; explicitCloseOnly?: boolean; initialFocus?: 'heading' | 'field'; footer?: ReactNode; headerActions?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const backdropDown = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallback = document.querySelector<HTMLElement>('.workspace .record-title button:not(:disabled), .workspace .topbar button:not(:disabled)');
    dialog?.showModal();
    const field = initialFocus === 'field' ? dialog?.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)') : null;
    (field || heading.current)?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      const target = opener?.isConnected && opener !== document.body && !opener.closest('[inert]') ? opener : fallback;
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return <dialog className={`modal glass ${wide ? 'wide' : ''} ${className}`} ref={ref} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!explicitCloseOnly) onClose(); }} onPointerDown={event => { backdropDown.current = event.target === event.currentTarget; }} onClick={event => {
      const startedOnBackdrop = backdropDown.current; backdropDown.current = false;
      if (!explicitCloseOnly && startedOnBackdrop && event.target === event.currentTarget) onClose();
    }} aria-labelledby={titleId}>
    <header className="modal-header"><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>{headerActions}<CloseButton className="modal-close" onClick={onClose}/></header><div className="modal-body">{children}</div>{footer && <footer className="modal-footer">{footer}</footer>}
  </dialog>;
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}
export function Status({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`status ${tone}`}>{children}</span>; }
export function Download({ href, children, iconLabel, disabled = false }: { href: string; children: ReactNode; iconLabel?: string; disabled?: boolean }) {
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [prepared,setPrepared] = useState<{url:string;filename:string}|null>(null), request = useRef<AbortController|null>(null);
  const dismiss = useCallback(() => { setNotice(''); setError(''); }, []);
  const native = isTauri(), [downloadReady, setDownloadReady] = useState(!native);
  const downloadUrl = useRef(''), timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!native) return;
    let active = true, stop: (() => void) | undefined;
    void listen<{url:string;success:boolean}>('client-download-finished', event => {
      if (!active || event.payload.url !== downloadUrl.current) return;
      downloadUrl.current = ''; clearTimeout(timer.current); setBusy(false);
      if (event.payload.success) setNotice('文件已保存至下载文件夹。');
      else setError('下载未完成，请点击重新下载。');
    }).then(unlisten => { if (active) { stop = unlisten; setDownloadReady(true); } else unlisten(); })
      .catch(() => { if (active) setError('无法接收下载结果，请重新打开导出窗口。'); });
    return () => { active = false; stop?.(); clearTimeout(timer.current); };
  }, [native]);
  useEffect(() => { setPrepared(null); setError(''); setNotice(''); setBusy(false); return () => { request.current?.abort(); request.current=null; downloadUrl.current=''; clearTimeout(timer.current); }; }, [href]);
  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.url); }, [prepared]);
  function beginSave(url: string) {
    if (!native) return;
    downloadUrl.current = url; setBusy(true); setError(''); setNotice(''); clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { downloadUrl.current = ''; setBusy(false); setError('未收到保存结果，请点击重新下载。'); }, 30000);
  }
  async function download() {
    if (request.current || downloadUrl.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setPrepared(null); setError(''); setNotice('');
    try {
      const file = await fetchDownload(href, controller.signal); if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file.blob); setPrepared({url,filename:file.filename});
      beginSave(url);
      const link = document.createElement('a'); link.href=url; link.download=file.filename; document.body.append(link); link.click(); link.remove();
      if (!native) setNotice('文件已准备。若浏览器拦截下载，请点击“重新下载”。');
    } catch (error) { if (!controller.signal.aborted) setError(messageOf(error)); }
    finally { if (request.current === controller) request.current=null; if (!controller.signal.aborted && !downloadUrl.current) setBusy(false); }
  }
  return <span className="download-control"><Button variant={iconLabel ? 'ghost' : 'secondary'} aria-label={iconLabel} aria-busy={busy} disabled={disabled || busy || !downloadReady} onClick={() => void download()}>{iconLabel ? children : busy ? '正在准备…' : children}</Button>
    {prepared && !busy && <a className="download-retry" href={prepared.url} download={prepared.filename} onClick={()=>beginSave(prepared.url)}>重新下载</a>}
    <Toast message={error || notice} error={Boolean(error)} dismiss={dismiss}/>
  </span>;
}

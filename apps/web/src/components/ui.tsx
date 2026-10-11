import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
export function Button({ children, variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button ${variant} ${className}`} {...props}>{children}</button>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal glass ${wide ? 'wide' : ''}`} ref={ref} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-label={title}>
    <header><h2>{title}</h2><Button variant="ghost" aria-label="关闭" onClick={onClose}><X size={20}/></Button></header>{children}
  </dialog>;
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}
export function Status({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`status ${tone}`}>{children}</span>; }
export function Download({ href, children }: { href: string; children: ReactNode }) { return <a className="button secondary" href={href} download>{children}</a>; }

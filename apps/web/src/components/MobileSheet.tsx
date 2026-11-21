import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';

export function MobileSheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const sheet = dialog.current!;
    sheet.showModal();
    document.dispatchEvent(new Event('meeting:chrome'));
    return () => {
      sheet.close();
      document.dispatchEvent(new Event('meeting:chrome'));
    };
  }, []);
  return <dialog ref={dialog} className="mobile-source-sheet" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientY < bounds.top || event.clientX < bounds.left || event.clientX > bounds.right) close();
    }}>
    <header className="mobile-sheet-heading">
      <h2 id={heading}>{title}</h2>
      <button type="button" className="mobile-sheet-close" aria-label="关闭" onClick={close}><X size={18}/></button>
    </header>
    {children}
  </dialog>;
}

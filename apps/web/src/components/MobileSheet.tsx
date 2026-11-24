import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, X } from '@phosphor-icons/react';

export function MobileSheet({ title, close, children, showClose = true, closeDisabled = false, placement = 'bottom', back = false }: {
  title: string; close: () => void; children: ReactNode; showClose?: boolean; closeDisabled?: boolean; placement?: 'bottom' | 'center'; back?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const sheet = dialog.current!;
    sheet.showModal();
    const initial = sheet.querySelector<HTMLElement>('[autofocus]') ?? titleRef.current;
    initial?.focus({ preventScroll: true });
    document.dispatchEvent(new Event('meeting:chrome'));
    return () => {
      sheet.close();
      document.dispatchEvent(new Event('meeting:chrome'));
    };
  }, []);
  return <dialog ref={dialog} className="mobile-source-sheet" data-placement={placement} aria-labelledby={heading}
    onCancel={event => {
      event.preventDefault();
      event.stopPropagation();
      if (!closeDisabled) close();
    }}
    onClick={event => {
      if (closeDisabled || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientY < bounds.top || event.clientY > bounds.bottom || event.clientX < bounds.left || event.clientX > bounds.right) close();
    }}>
    <header className="mobile-sheet-heading" data-back={back || undefined}>
      <h2 id={heading} ref={titleRef} tabIndex={-1}>{title}</h2>
      {showClose && <button type="button" className="mobile-sheet-close" aria-label={back ? '返回' : '关闭'} disabled={closeDisabled} onClick={close}>{back ? <ArrowLeft size={18}/> : <X size={18}/> }</button>}
    </header>
    <div className="mobile-sheet-body">{children}</div>
  </dialog>;
}

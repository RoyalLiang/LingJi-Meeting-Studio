import { useEffect, useLayoutEffect, useRef } from 'react';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
let visibleToast: HTMLDivElement | null = null;
export function Toast({ message, error = false, dismiss }: { message: string; error?: boolean; dismiss: () => void }) {
  const ref=useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element=ref.current; if (!message || !element?.showPopover) return;
    if (visibleToast?.matches(':popover-open')) visibleToast.hidePopover();
    visibleToast = element; element.showPopover();
    return () => {
      if(element.isConnected && element.matches(':popover-open'))element.hidePopover();
      if (visibleToast === element) visibleToast = null;
    };
  }, [message]);
  useEffect(() => { if (!message) return; const timer = setTimeout(dismiss, 8000); return () => clearTimeout(timer); }, [message, dismiss]);
  if (!message) return null;
  return <div ref={ref} popover="manual" className={`toast glass ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
    {error ? <WarningCircle size={21}/> : <CheckCircle size={21}/>}<span>{message}</span><button className="button ghost" type="button" aria-label="关闭提示" onClick={dismiss}><X size={16}/></button>
  </div>;
}

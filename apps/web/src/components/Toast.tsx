import { useEffect, useLayoutEffect, useRef } from 'react';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import './Toast.css';

export function getToastDuration() {
  return 2000;
}

export function createToastTimer(duration: number, dismiss: () => void) {
  let remaining = duration, startedAt = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const pauses = new Set<string>();
  const stop = () => {
    if (timer === undefined) return;
    clearTimeout(timer); timer = undefined;
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
  };
  const start = () => {
    if (disposed || pauses.size || timer !== undefined) return;
    startedAt = performance.now();
    timer = setTimeout(() => { timer = undefined; disposed = true; dismiss(); }, remaining);
  };
  start();
  return {
    setPaused(reason: string, paused: boolean) {
      if (disposed) return;
      if (paused) { pauses.add(reason); stop(); }
      else { pauses.delete(reason); start(); }
    },
    dispose() { stop(); disposed = true; }
  };
}

let toastStack: HTMLDivElement[] = [];
const toastPriority = new WeakMap<HTMLDivElement,number>();
function promoteToast(element: HTMLDivElement, priority: number) {
  const previous=toastStack.at(-1);
  toastPriority.set(element,priority);
  toastStack=toastStack.filter(item=>item!==element && item.isConnected);
  toastStack.push(element);
  toastStack.sort((a,b)=>(toastPriority.get(a)||0)-(toastPriority.get(b)||0));
  const top=toastStack.at(-1)!;
  if(previous!==top && previous?.matches(':popover-open')) previous.hidePopover();
  if(!top.matches(':popover-open')) top.showPopover();
}

type ToastProps = { message: string; error?: boolean; warning?: boolean; persistent?: boolean; inline?: boolean; className?: string; messageKey?: string | number; dismiss: () => void;
  action?: { label: string; run: () => void; disabled?: boolean; busy?: boolean } };
export function Toast({ message, error = false, warning = false, persistent = false, inline = false, className = '', messageKey, dismiss, action }: ToastProps) {
  const ref = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof createToastTimer> | null>(null), dismissRef = useRef(dismiss);
  useLayoutEffect(() => { dismissRef.current = dismiss; }, [dismiss]);
  useLayoutEffect(() => {
    const element=ref.current;
    if(inline || !message || !element?.showPopover) return;
    promoteToast(element,error?3:warning?2:1);
    return () => {
      const wasVisible=toastStack.at(-1)===element;
      toastStack=toastStack.filter(item=>item!==element && item.isConnected);
      if(element.isConnected && element.matches(':popover-open')) element.hidePopover();
      if(wasVisible) toastStack.at(-1)?.showPopover();
    };
  },[message,messageKey,inline,error,warning]);
  useEffect(() => {
    if (!message || error || persistent) return;
    const countdown = createToastTimer(getToastDuration(), () => dismissRef.current());
    timer.current = countdown;
    countdown.setPaused('hover', Boolean(ref.current?.matches(':hover')));
    countdown.setPaused('focus', Boolean(ref.current?.contains(document.activeElement)));
    const visibility = () => countdown.setPaused('hidden', document.hidden);
    const element = ref.current;
    const toggle = (event: Event) => countdown.setPaused('covered', (event as ToggleEvent).newState !== 'open');
    countdown.setPaused('covered', Boolean(element?.showPopover && !element.matches(':popover-open')));
    element?.addEventListener('beforetoggle', toggle);
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { countdown.dispose(); timer.current = null; element?.removeEventListener('beforetoggle', toggle); document.removeEventListener('visibilitychange', visibility); };
  }, [message, messageKey, error, persistent]);
  if (!message) return null;
  const popover = !inline && typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype ? 'manual' : undefined;
  return <div ref={ref} popover={popover} className={`toast feedback-toast glass ${inline ? 'is-inline' : ''} ${error ? 'is-error' : warning ? 'is-warning' : ''} ${className}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true"
    onMouseEnter={() => timer.current?.setPaused('hover', true)} onMouseLeave={() => timer.current?.setPaused('hover', false)}
    onFocus={() => timer.current?.setPaused('focus', true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) timer.current?.setPaused('focus', false); }}>
    {error || warning ? <WarningCircle size={21} aria-hidden="true"/> : <CheckCircle size={21} aria-hidden="true"/>}<div className="toast-content"><span>{message}</span>{action && <button className="toast-action" type="button" disabled={action.disabled} aria-busy={action.busy} onClick={action.run}>{action.label}</button>}</div><button className="button ghost toast-dismiss" type="button" aria-label="关闭提示" onClick={dismiss}><X size={16} aria-hidden="true"/></button>
  </div>;
}

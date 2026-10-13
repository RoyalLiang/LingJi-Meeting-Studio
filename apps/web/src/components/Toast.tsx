import { useEffect, useLayoutEffect, useRef } from 'react';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import './Toast.css';

export function getToastDuration(message: string) {
  return Math.min(10000, 5000 + Math.max(0, Array.from(message).length - 40) * 75);
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
type ToastProps = { message: string; error?: boolean; persistent?: boolean; messageKey?: string | number; dismiss: () => void };
export function Toast({ message, error = false, persistent = false, messageKey, dismiss }: ToastProps) {
  const ref = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof createToastTimer> | null>(null), dismissRef = useRef(dismiss);
  useLayoutEffect(() => { dismissRef.current = dismiss; }, [dismiss]);
  useLayoutEffect(() => {
    const element = ref.current; if (!message || !element?.showPopover) return;
    const previous = toastStack.at(-1);
    if (previous?.matches(':popover-open')) previous.hidePopover();
    toastStack.push(element); element.showPopover();
    return () => {
      const wasVisible = toastStack.at(-1) === element;
      toastStack = toastStack.filter(item => item !== element && item.isConnected);
      if (element.isConnected && element.matches(':popover-open')) element.hidePopover();
      if (wasVisible) toastStack.at(-1)?.showPopover();
    };
  }, [message]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!message || !element?.showPopover || toastStack.at(-1) === element) return;
    const previous = toastStack.at(-1);
    if (previous?.matches(':popover-open')) previous.hidePopover();
    toastStack = toastStack.filter(item => item !== element && item.isConnected);
    toastStack.push(element); element.showPopover();
  }, [message, messageKey]);
  useEffect(() => {
    if (!message || error || persistent) return;
    const countdown = createToastTimer(getToastDuration(message), () => dismissRef.current());
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
  const popover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype ? 'manual' : undefined;
  return <div ref={ref} popover={popover} className={`toast feedback-toast glass ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true"
    onMouseEnter={() => timer.current?.setPaused('hover', true)} onMouseLeave={() => timer.current?.setPaused('hover', false)}
    onFocus={() => timer.current?.setPaused('focus', true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) timer.current?.setPaused('focus', false); }}>
    {error ? <WarningCircle size={21} aria-hidden="true"/> : <CheckCircle size={21} aria-hidden="true"/>}<span>{message}</span><button className="button ghost toast-dismiss" type="button" aria-label="关闭提示" onClick={dismiss}><X size={16} aria-hidden="true"/></button>
  </div>;
}

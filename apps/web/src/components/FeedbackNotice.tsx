import { useState } from 'react';
import { Toast } from './Toast';

function acknowledged(key?: string) {
  try { return Boolean(key && globalThis.localStorage?.getItem(`lingji:notice:${key}`) === 'dismissed'); }
  catch { return false; }
}

/** The caller keys a persisted notice by incident; explicit reopening bypasses its acknowledgement. */
export function FeedbackNotice({ message, action, warning = true, open = true, dismissalKey, forceOpen = false }: {
  message: string; warning?: boolean; open?: boolean; dismissalKey?: string; forceOpen?: boolean;
  action?: { label: string; run: () => void; disabled?: boolean; busy?: boolean };
}) {
  const [dismissed, setDismissed] = useState(() => !forceOpen && acknowledged(dismissalKey));
  function dismiss() {
    setDismissed(true);
    try { if (dismissalKey) globalThis.localStorage?.setItem(`lingji:notice:${dismissalKey}`, 'dismissed'); }
    catch { /* Storage may be unavailable; closing still works for this mounted notice. */ }
  }
  return dismissed || !open ? null : <Toast message={message} warning={warning} persistent action={action} dismiss={dismiss}/>;
}

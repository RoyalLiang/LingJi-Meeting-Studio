import { useState } from 'react';
import { Toast } from './Toast';

/** Keep a stable notification identity so refreshes cannot reopen a dismissed warning. */
export function FeedbackNotice({ message, action, warning = true, open = true }: {
  message: string; warning?: boolean; open?: boolean; action?: { label: string; run: () => void; disabled?: boolean; busy?: boolean };
}) {
  const [dismissed, setDismissed] = useState(false);
  return dismissed || !open ? null : <Toast message={message} warning={warning} persistent action={action} dismiss={() => setDismissed(true)}/>;
}

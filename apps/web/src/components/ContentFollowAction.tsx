import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';

export function ContentFollowAction({ anchor, visible, resume }: { anchor: RefObject<HTMLElement | null>; visible: boolean; resume: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(anchor.current?.closest('.workspace-body')?.querySelector<HTMLElement>('[data-content-follow-actions]') || null);
  }, [anchor]);
  if (!visible) return null;
  const action = <Button className="minutes-follow" onClick={resume}>回到最新纪要</Button>;
  return host ? createPortal(action, host) : <div className="content-follow-actions">{action}</div>;
}

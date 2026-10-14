import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown } from '@phosphor-icons/react';
import { Button } from './ui';

export function ContentFollowAction({ anchor, visible, resume }: { anchor: RefObject<HTMLElement | null>; visible: boolean; resume: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(anchor.current?.closest('.workspace-body')?.querySelector<HTMLElement>('[data-content-follow-actions]') || null);
  }, [anchor]);
  if (!visible) return null;
  const action = <Button className="minutes-follow" aria-label="回到最新纪要" title="回到最新纪要" onClick={resume}><ArrowDown size={23} weight="bold" aria-hidden="true"/></Button>;
  return host ? createPortal(action, host) : <div className="content-follow-actions">{action}</div>;
}

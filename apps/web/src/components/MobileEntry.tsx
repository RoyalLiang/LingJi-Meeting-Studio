import { Component, useEffect, useState, type ReactNode } from 'react';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
import { Brand } from './Brand';
import { Button } from './ui';
import './MobileEntry.css';

export function MobileEntry({ failed = false }: { failed?: boolean }) {
  const [takingLong, setTakingLong] = useState(false);
  useEffect(() => {
    if (failed) return;
    const timer = window.setTimeout(() => setTakingLong(true), 8000);
    return () => clearTimeout(timer);
  }, [failed]);
  return <section className={failed ? 'phone-entry phone-entry-failure' : 'phone-entry'}
    role={failed ? 'alert' : 'status'} aria-label={failed ? undefined : '聆记'} aria-busy={!failed}>
    <Brand markOnly/>
    {failed && <><WarningCircle className="phone-entry-indicator" size={24} aria-hidden="true"/><h1>页面暂时无法打开</h1></>}
    {failed || takingLong ? <Button variant="ghost" onClick={() => location.reload()}><ArrowClockwise size={16}/>重新加载</Button> : null}
  </section>;
}

export class MobileEntryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <MobileEntry failed/> : this.props.children; }
}

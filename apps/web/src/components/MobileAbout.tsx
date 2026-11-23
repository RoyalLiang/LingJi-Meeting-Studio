import { useEffect, useRef, useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import { audioNoticeTitle } from './MobileAudioNotice';
import { Button } from './ui';

const updateLabels = {
  idle: '检查更新',
  checking: '检查中…',
  current: '已是最新版',
  available: '发现新版本',
  empty: '暂无更新包',
  error: '重试检查',
} as const;
type UpdateState = keyof typeof updateLabels;

export function MobileAbout({ openNotice }: { openNotice: () => void }) {
  const version = /\bLingJi-Android\/([\w.-]+)/.exec(navigator.userAgent)?.[1];
  const [state, setState] = useState<UpdateState>('idle');
  const [available, setAvailable] = useState('');
  const pending = useRef<{ id: string; timeout: number } | null>(null);
  useEffect(() => {
    const checked = (event: Event) => {
      const active = pending.current;
      const response = (event as CustomEvent<string>).detail;
      if (!active || !response.startsWith(active.id + ':')) return;
      window.clearTimeout(active.timeout);
      pending.current = null;
      const result = response.slice(active.id.length + 1);
      const newer = /^available:([1-9]\d{0,8})$/.exec(result);
      setAvailable(newer ? '0.4-preview.' + newer[1] : '');
      setState(newer ? 'available' : result === 'current' || result === 'empty' ? result : 'error');
    };
    addEventListener('lingji:update-result', checked);
    return () => {
      removeEventListener('lingji:update-result', checked);
      window.clearTimeout(pending.current?.timeout);
    };
  }, []);
  return <div className="mobile-about">
    {version && <div className="mobile-about-build">
      <span className="mobile-about-version">{version}</span>
      <Button variant="secondary" data-update-state={state} aria-live="polite" aria-busy={state === 'checking'}
        title={available || undefined} disabled={state === 'checking'} onClick={() => {
          if (pending.current) return;
          setAvailable('');
          setState('checking');
          const id = crypto.randomUUID();
          const timeout = window.setTimeout(() => {
            pending.current = null;
            setState('error');
          }, 15000);
          pending.current = { id, timeout };
          dispatchEvent(new CustomEvent('lingji:check-update', { detail: id }));
        }}>{updateLabels[state]}</Button>
    </div>}
    <button type="button" className="mobile-about-row mobile-document-link" onClick={openNotice}>
      <span>{audioNoticeTitle}</span><CaretRight size={16} aria-hidden="true"/>
    </button>
  </div>;
}

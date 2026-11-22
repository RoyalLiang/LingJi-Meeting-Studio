import { useEffect, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { MobileAudioNotice } from './MobileAudioNotice';
import { Button } from './ui';

export function MobileAbout() {
  const version = /\bLingJi-Android\/([\w.-]+)/.exec(navigator.userAgent)?.[1];
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState('');
  useEffect(() => {
    const checked = (event: Event) => {
      setChecking(false);
      setUpdate((event as CustomEvent<string>).detail);
    };
    addEventListener('lingji:update-result', checked);
    return () => removeEventListener('lingji:update-result', checked);
  }, []);
  return <div className="mobile-about">
    <div className="mobile-about-build">
      <dl><dt>当前版本</dt><dd>{version || '网页预览'}</dd></dl>
      {version && <Button variant="secondary" disabled={checking} onClick={() => {
        setChecking(true);
        setUpdate('');
        dispatchEvent(new Event('lingji:check-update'));
      }}>{checking ? '正在检查…' : '检查更新'}</Button>}
      {update && <p role="status" className="mobile-about-result">{update}</p>}
    </div>
    {version && <button type="button" className="mobile-about-row" onClick={() => dispatchEvent(new Event('lingji:open-releases'))}>
      <span>查看发布记录</span><ArrowSquareOut size={17} aria-hidden="true"/>
    </button>}
    <MobileAudioNotice/>
  </div>;
}

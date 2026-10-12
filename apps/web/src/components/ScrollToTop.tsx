import { useEffect, useState, type RefObject } from 'react';
import { ArrowUp } from '@phosphor-icons/react';
import { Button } from './ui';

export function ScrollToTop({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const container = root.current; if (!container) return;
    const update = () => setVisible(container.scrollTop > 320);
    update(); container.addEventListener('scroll', update, { passive: true });
    return () => container.removeEventListener('scroll', update);
  }, [root]);
  if (!visible) return null;
  return <Button className="scroll-top glass" aria-label="回到页面顶部" onClick={() => {
    const container = root.current; if (!container) return;
    container.dispatchEvent(new Event('meeting:jump-top'));
    container.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }}><ArrowUp size={18}/><span>顶部</span></Button>;
}

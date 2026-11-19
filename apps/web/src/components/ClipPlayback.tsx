import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from '@phosphor-icons/react';
import { Button } from './ui';

type ClipState = { key: string; state: 'loading' | 'playing' | 'failed' };
let stopActiveClip: (() => void) | undefined;

export function useClipPlayback(enabled = true) {
  const current = useRef<{ key: string; stop: () => void } | null>(null);
  const [status, setStatus] = useState<ClipState | null>(null);
  const stop = useCallback(() => { current.current?.stop(); setStatus(null); }, []);
  useEffect(() => {
    if (!enabled) stop();
    return stop;
  }, [enabled, stop]);

  function toggle(key: string, url: string) {
    if (!enabled) return;
    if (current.current?.key === key) { stop(); return; }
    stopActiveClip?.();
    const audio = new Audio();
    const dispose = () => {
      if (current.current?.stop !== dispose) return;
      current.current = null;
      if (stopActiveClip === dispose) stopActiveClip = undefined;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setStatus(null);
    };
    const fail = () => {
      if (current.current?.stop !== dispose) return;
      dispose();
      setStatus({ key, state: 'failed' });
    };
    current.current = { key, stop: dispose };
    stopActiveClip = dispose;
    audio.addEventListener('ended', dispose, { once: true });
    audio.addEventListener('error', fail, { once: true });
    setStatus({ key, state: 'loading' });
    audio.src = url;
    void audio.play().then(() => {
      if (current.current?.stop === dispose) setStatus({ key, state: 'playing' });
    }, fail);
  }
  return { status, toggle, stop };
}

export function ClipPlayButton({ label, state, disabled, toggle }: {
  label: string; state?: ClipState['state']; disabled?: boolean; toggle: () => void;
}) {
  const active = state === 'playing' || state === 'loading';
  const text = disabled ? label : `${active ? '停止' : '试听'}${label}`;
  return <Button type="button" className="clip-play" aria-label={text} disabled={disabled} aria-busy={state === 'loading'} onClick={toggle}>
    {active ? <Pause size={15} weight="fill" aria-hidden="true"/> : <Play size={15} weight="fill" aria-hidden="true"/>}
  </Button>;
}

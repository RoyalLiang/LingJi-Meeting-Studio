import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowCounterClockwise, Play, Pause, WarningCircle } from '@phosphor-icons/react';
import { Button } from './ui';
import { timecode } from '../model';
import './AudioPlayer.css';

type Props = { src: string; label: string; autoPlay?: boolean; sourceIcon?: ReactNode };

// A new source gets a fresh media element and playback state.
export function AudioPlayer(props: Props) {
  return <PlaybackControls key={props.src} {...props}/>;
}

function PlaybackControls({ src, label, autoPlay = false, sourceIcon }: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const scrubbing = useRef(false), resumeAfterScrub = useRef(false);
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0), [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = audio.current;
    let active = true;
    if (autoPlay) void element?.play().catch(() => { if (active) setError('播放未成功，请重试。'); });
    return () => { active = false; element?.pause(); };
  }, [autoPlay]);

  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const follow = () => {
      if (!scrubbing.current) setTime(audio.current?.currentTime || 0);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const syncTime = () => { if (!scrubbing.current) setTime(audio.current?.currentTime || 0); };
  const syncDuration = () => {
    const next = audio.current?.duration || 0;
    setDuration(Number.isFinite(next) && next > 0 ? next : 0);
  };
  const play = async () => {
    try { await audio.current?.play(); }
    catch { setError('播放未成功，请重试。'); }
  };
  const beginScrub = () => {
    if (!duration || scrubbing.current) return;
    scrubbing.current = true;
    resumeAfterScrub.current = Boolean(audio.current && !audio.current.paused);
    audio.current?.pause();
    setDragging(true);
  };
  const finishScrub = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    setDragging(false);
    const resume = resumeAfterScrub.current;
    resumeAfterScrub.current = false;
    if (resume && audio.current && audio.current.currentTime < duration) void play();
  };
  const seek = (value: number) => {
    const next = Math.min(duration, Math.max(0, value));
    if (audio.current) audio.current.currentTime = next;
    setTime(next);
  };
  const reset = () => {
    scrubbing.current = false;
    resumeAfterScrub.current = false;
    setDragging(false);
    audio.current?.pause();
    seek(0);
  };
  const position = Math.min(time, duration);
  const progress = duration ? position / duration * 100 : 0;
  const action = playing ? '暂停' : position > 0 ? '继续' : '播放';
  const timestamp = `${timecode(position * 1000)} / ${timecode(duration * 1000)}`;

  return <div className="audio-player" role="group" aria-label={`${label}原音播放`} data-scrubbing={dragging}>
    <audio ref={audio} preload="metadata" src={src} onTimeUpdate={syncTime} onSeeked={syncTime}
      onLoadedMetadata={() => { syncDuration(); setError(''); }} onDurationChange={syncDuration}
      onPlay={() => { setPlaying(true); setError(''); }} onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); syncTime(); }}
      onError={() => { setPlaying(false); setError('原音加载失败，请检查网络与留存状态。'); }}/>
    {sourceIcon && <span className="player-source" role="img" aria-label={label} title={label}>{sourceIcon}</span>}
    <Button className="player-control" aria-label={`${action}${label}`} title={`${action}${label}`}
      onClick={() => { if (playing) audio.current?.pause(); else void play(); }}>
      {playing ? <Pause size={18} weight="fill" aria-hidden="true"/> : <Play size={18} weight="fill" aria-hidden="true"/>}
    </Button>
    <Button className="player-control player-reset" aria-label={`重置${label}`} title={`重置${label}`} disabled={!duration} onClick={reset}>
      <ArrowCounterClockwise size={18} aria-hidden="true"/>
    </Button>
    <div className="player-timeline" style={{ '--playback-progress': `${progress}%` } as CSSProperties}>
      <div className="player-scale" aria-hidden="true">
        <div className="player-progress"><div className="player-progress-fill"/></div>
        <div className="player-ruler">{Array.from({ length: 41 }, (_, i) =>
          <i key={i} className={i % 5 === 0 ? 'major' : undefined} style={{ left: `${i * 2.5}%` }}/>)}</div>
      </div>
      <input type="range" className="player-seek" aria-label={`${label}播放进度`} aria-valuetext={timestamp} title={timestamp}
        disabled={!duration} min={0} max={duration} step={0.1} value={position}
        onChange={event => seek(Number(event.target.value))}
        onPointerDown={event => { if (event.button === 0) { beginScrub(); event.currentTarget.setPointerCapture(event.pointerId); } }}
        onPointerUp={finishScrub} onPointerCancel={finishScrub} onLostPointerCapture={finishScrub} onBlur={finishScrub}/>
    </div>
    {error && <span className="player-error" role="alert" aria-label={error} title={error}><WarningCircle size={20} aria-hidden="true"/></span>}
  </div>;
}

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowCounterClockwise, Play, Pause, WarningCircle } from '@phosphor-icons/react';
import { Button } from './ui';
import { timecode } from '../model';
import { PlaybackScrub, PlaybackTransport } from '../audio/playback-transport';
import './AudioPlayer.css';

type Track = { id: string; src: string; label: string };
type Props = { sources: Track[]; autoPlay?: boolean };

export function AudioPlayer(props: Props) {
  return <PlaybackControls key={props.sources.map(source => source.src).join('|')} {...props}/>;
}

function PlaybackControls({ sources, autoPlay = false }: Props) {
  const audio = useRef<(HTMLAudioElement | null)[]>([]);
  const [transport] = useState(() => new PlaybackTransport(() => audio.current.filter((media): media is HTMLAudioElement => Boolean(media))));
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0), [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<number | null>(null), previewFrame = useRef(0), pendingTime = useRef(0);
  const [scrub] = useState(() => new PlaybackScrub(transport, value => { pendingTime.current = value; }));

  useEffect(() => {
    let active = true;
    if (autoPlay) void transport.play().then(() => { if (active) setPlaying(transport.playing); })
      .catch(() => { if (active) setError('播放未成功，请重试。'); });
    return () => { active = false; transport.pause(); cancelAnimationFrame(previewFrame.current); };
  }, [autoPlay, transport]);

  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const follow = () => {
      if (!scrub.active) setTime(transport.time);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [playing, scrub, transport]);

  const syncTime = () => { if (!scrub.active) setTime(transport.time); };
  const syncDuration = () => setDuration(transport.duration);
  const play = async () => {
    try { await transport.play(); setPlaying(transport.playing); setError(''); }
    catch { setPlaying(false); setError('播放未成功，请重试。'); }
  };
  const flushPreview = () => {
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = 0;
    setTime(pendingTime.current);
  };
  const preview = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    scrub.move((event.clientX - bounds.left - 7) / Math.max(1, bounds.width - 14) * duration);
    if (!previewFrame.current) previewFrame.current = requestAnimationFrame(flushPreview);
  };
  const finishScrub = (commit = true) => {
    if (!scrub.active) return;
    const resume = scrub.finish(commit);
    pointer.current = null;
    setDragging(false);
    flushPreview();
    if (resume) void play();
  };
  const beginScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || !duration || scrub.active) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = event.pointerId;
    scrub.begin(); setPlaying(false); setDragging(true); preview(event);
  };
  const seek = (value: number) => {
    const resume = transport.playing;
    transport.pause(); setPlaying(false); setTime(transport.seek(value));
    if (resume && value < duration) void play();
  };
  const keyboardSeek = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!duration || scrub.active) return;
    const step = event.shiftKey ? 30 : 5;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? duration
      : ['ArrowRight', 'ArrowUp'].includes(event.key) ? time + step
      : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? time - step
      : event.key === 'PageUp' ? time + 30 : event.key === 'PageDown' ? time - 30 : null;
    if (next === null) return;
    event.preventDefault(); seek(next);
  };
  const reset = () => {
    scrub.finish(false, false); pointer.current = null; setDragging(false);
    cancelAnimationFrame(previewFrame.current); previewFrame.current = 0;
    transport.pause(); setPlaying(false); setTime(transport.seek(0));
  };
  const position = Math.min(time, duration);
  const progress = duration ? position / duration * 100 : 0;
  const action = playing ? '暂停' : position > 0 ? '继续' : '播放';
  const timestamp = `${timecode(position * 1000)} / ${timecode(duration * 1000)}`;

  return <div className="audio-player" role="group" aria-label="原音播放" data-scrubbing={dragging}>
    {sources.map((source, index) => <audio key={source.id} ref={element => { audio.current[index] = element; }}
      preload="metadata" src={source.src} aria-label={source.label} onTimeUpdate={syncTime} onSeeked={syncTime}
      onLoadedMetadata={() => { syncDuration(); setError(''); }} onDurationChange={syncDuration}
      onPlay={() => { setPlaying(transport.playing); setError(''); }} onPause={() => setPlaying(transport.playing)}
      onEnded={() => { setPlaying(transport.playing); syncTime(); }}
      onError={() => { transport.pause(); setPlaying(false); setError('原音加载失败，请检查网络与留存状态。'); }}/>) }
    <Button className="player-control" aria-label={`${action}原音`} title={`${action}原音`}
      onClick={() => { if (playing) { transport.pause(); setPlaying(false); } else void play(); }}>
      {playing ? <Pause size={18} weight="fill" aria-hidden="true"/> : <Play size={18} weight="fill" aria-hidden="true"/>}
    </Button>
    <Button className="player-control player-reset" aria-label="重置原音" title="重置原音" disabled={!duration} onClick={reset}>
      <ArrowCounterClockwise size={18} aria-hidden="true"/>
    </Button>
    <div className="player-timeline" style={{ '--playback-progress': `${progress}%` } as CSSProperties}>
      <div className="player-scale" aria-hidden="true">
        <span className="player-current-time">{timecode(position * 1000)}</span>
        <div className="player-progress"><div className="player-progress-fill"/></div>
        <div className="player-ruler">{Array.from({ length: 41 }, (_, i) =>
          <i key={i} className={i % 5 === 0 ? 'major' : undefined} style={{ left: `${i * 2.5}%` }}/>)}</div>
        <span className="player-thumb"/>
      </div>
      <div className="player-seek" role="slider" aria-label="原音播放进度" aria-valuetext={timestamp}
        aria-valuemin={0} aria-valuemax={duration} aria-valuenow={position} aria-disabled={!duration} tabIndex={duration ? 0 : -1}
        onKeyDown={keyboardSeek} onPointerDown={beginScrub}
        onPointerMove={event => { if (event.pointerId === pointer.current) preview(event); }}
        onPointerUp={event => { if (event.pointerId === pointer.current) { preview(event); finishScrub(); } }}
        onPointerCancel={() => finishScrub(false)} onLostPointerCapture={() => finishScrub(false)} onBlur={() => finishScrub(false)}/>
    </div>
    <span className="player-duration" aria-label={`总时长 ${timecode(duration * 1000)}`}>
      {duration ? timecode(duration * 1000) : '--:--'}
    </span>
    {error && <span className="player-error" role="alert" aria-label={error} title={error}><WarningCircle size={20} aria-hidden="true"/></span>}
  </div>;
}

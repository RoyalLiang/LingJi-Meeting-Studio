import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Play, Pause, ArrowCounterClockwise, ArrowClockwise, Waveform } from '@phosphor-icons/react';
import { Button } from './ui';
import { Toast } from './Toast';
import { PlaybackTransport, PlaybackScrub } from '../audio/playback-transport';
import './AudioPlayer.css';

type Track = { id: string; src: string; label: string };
type Props = { sources: Track[] };
const rates = [0.75, 1, 1.25, 1.5, 2];
const seekKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
function clock(value: number) {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AudioPlayer(props: Props) {
  return <PlaybackControls key={props.sources.map(source => source.src).join('|')} {...props}/>;
}

function PlaybackControls({ sources }: Props) {
  const audio = useRef<(HTMLAudioElement | null)[]>([]), operation = useRef(0);
  const [transport] = useState(() => new PlaybackTransport(() => audio.current.filter((media): media is HTMLAudioElement => Boolean(media))));
  const [playing, setPlaying] = useState(false), [starting, setStarting] = useState(false), [error, setError] = useState('');
  const [time, setTime] = useState(0), [duration, setDuration] = useState(0), [rate, setRate] = useState(1);
  const [scrub] = useState(() => new PlaybackScrub(transport, setTime));

  useEffect(() => () => { operation.current++; scrub.finish(false, false); transport.pause(); }, [transport, scrub]);

  const sync = () => {
    setPlaying(transport.playing);
    setDuration(transport.duration);
    if (!scrub.active) setTime(transport.time);
  };
  const run = async (action: () => Promise<unknown>) => {
    const current = ++operation.current;
    setStarting(true);
    try {
      await action();
      if (current === operation.current) { sync(); setError(''); }
    } catch {
      if (current === operation.current) { sync(); setError('播放未成功，请检查网络后重试。'); }
    } finally { if (current === operation.current) setStarting(false); }
  };
  const play = () => run(async () => {
    if (transport.duration && transport.time >= transport.duration) transport.seek(0);
    await transport.play();
  });
  const pause = () => { operation.current++; transport.pause(); setStarting(false); sync(); };
  const beginScrub = () => { operation.current++; setStarting(false); scrub.begin(); sync(); };
  const finishScrub = (commit = true) => {
    if (scrub.finish(commit)) void run(() => transport.play());
    else sync();
  };

  return <div className="audio-player" role="group" aria-label="原音播放">
    {sources.map((source, index) => <audio key={source.id} ref={element => { audio.current[index] = element; }}
      preload="metadata" src={source.src} aria-label={source.label}
      onLoadedMetadata={() => { sync(); setError(''); }} onDurationChange={sync}
      onTimeUpdate={sync} onSeeked={sync} onPlay={sync} onPause={sync} onEnded={sync}
      onError={() => { pause(); setError('原音加载失败，请检查网络与留存状态后重试。'); }}/>) }
    <span className="player-label"><Waveform size={19} aria-hidden="true"/><span>会议录音</span></span>
    <div className="player-buttons">
      <Button className="player-control player-jump" disabled={!duration} aria-label="后退 15 秒" title="后退 15 秒" onClick={() => void run(() => transport.skip(-15))}>
        <ArrowCounterClockwise size={25} aria-hidden="true"/><span aria-hidden="true">15</span>
      </Button>
      <Button className="player-control player-toggle" aria-label={playing || starting ? '暂停原音' : '播放原音'} title={playing || starting ? '暂停原音' : '播放原音'} aria-busy={starting}
        onClick={() => { if (playing || starting) pause(); else void play(); }}>
        {playing || starting ? <Pause size={18} weight="fill" aria-hidden="true"/> : <Play size={18} weight="fill" aria-hidden="true"/>}
      </Button>
      <Button className="player-control player-jump" disabled={!duration} aria-label="快进 15 秒" title="快进 15 秒" onClick={() => void run(() => transport.skip(15))}>
        <ArrowClockwise size={25} aria-hidden="true"/><span aria-hidden="true">15</span>
      </Button>
    </div>
    <input className="player-seek" type="range" min={0} max={duration || 1} step={0.1} value={Math.min(time, duration || 0)} disabled={!duration}
      aria-label="录音进度" aria-valuetext={duration ? `${clock(time)}，共 ${clock(duration)}` : '正在读取录音时长'}
      style={{ '--played': `${duration ? time / duration * 100 : 0}%` } as CSSProperties}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); beginScrub(); }}
      onChange={event => { const immediate = !scrub.active; if (immediate) beginScrub(); scrub.move(Number(event.currentTarget.value)); if (immediate) finishScrub(); }}
      onPointerUp={() => finishScrub()} onPointerCancel={() => finishScrub(false)} onLostPointerCapture={() => finishScrub(false)}
      onKeyDown={event => { if (seekKeys.has(event.key)) beginScrub(); else if (event.key === 'Escape') { event.preventDefault(); finishScrub(false); } }}
      onKeyUp={event => { if (seekKeys.has(event.key)) finishScrub(); }} onBlur={() => finishScrub()}/>
    <span className="player-time" aria-hidden="true">{clock(time)}<span> / {duration ? clock(duration) : '--:--'}</span></span>
    <select className="player-rate" aria-label="播放速度" value={rate} onChange={event => { const value = Number(event.currentTarget.value); transport.setRate(value); setRate(value); }}>
      {rates.map(value => <option key={value} value={value}>{value}×</option>)}
    </select>
    {error && <Toast message={error} error dismiss={() => setError('')} action={{ label: '重试播放', run: () => void play(), disabled: starting }}/>}
  </div>;
}

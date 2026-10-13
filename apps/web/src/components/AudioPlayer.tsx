import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SpeakerHigh } from '@phosphor-icons/react';
import { Button } from './ui';
import { timecode } from '../model';
export function AudioPlayer({ src, label }: { src: string; label: string }) {
  const audio = useRef<HTMLAudioElement>(null), [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [duration, setDuration] = useState(0), [error, setError] = useState('');
  useEffect(() => { const element = audio.current; return () => { element?.pause(); }; }, [src]);
  return <div className="audio-player"><audio ref={audio} preload="metadata" src={src} onTimeUpdate={() => setTime(audio.current?.currentTime || 0)} onLoadedMetadata={() => { setDuration(Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0); setError(''); }} onPlay={() => { setPlaying(true); setError(''); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError('原音加载失败，请检查网络与留存状态。')}/>
    <Button aria-label={`${playing ? '暂停' : '播放'}${label}`} onClick={async () => { try { if (playing) audio.current?.pause(); else await audio.current?.play(); } catch { setError('播放未成功，请重试。'); } }}>{playing ? <Pause size={18} weight="fill"/> : <Play size={18} weight="fill"/>}</Button>
    <div className="player-track"><span>{label}</span><input type="range" className="range" aria-label={`${label}播放进度`} disabled={!duration} min={0} max={Number.isFinite(duration) ? duration : 0} step={0.1} value={Math.min(time, duration)} onChange={e => { const next = Math.min(duration, Math.max(0, Number(e.target.value))); if (audio.current) audio.current.currentTime = next; setTime(next); }}/></div><small>{timecode(time * 1000)} / {timecode(duration * 1000 || 0)}</small><SpeakerHigh size={18}/>{error && <p role="alert">{error}</p>}
  </div>;
}

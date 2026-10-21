import { useEffect, useRef, useState } from 'react';
import { Play, Pause, WarningCircle } from '@phosphor-icons/react';
import { Button } from './ui';
import { PlaybackTransport } from '../audio/playback-transport';
import './AudioPlayer.css';

type Track = { id: string; src: string; label: string };
type Props = { sources: Track[] };

export function AudioPlayer(props: Props) {
  return <PlaybackControls key={props.sources.map(source => source.src).join('|')} {...props}/>;
}

function PlaybackControls({ sources }: Props) {
  const audio = useRef<(HTMLAudioElement | null)[]>([]);
  const [transport] = useState(() => new PlaybackTransport(() => audio.current.filter((media): media is HTMLAudioElement => Boolean(media))));
  const [playing, setPlaying] = useState(false), [error, setError] = useState('');

  useEffect(() => () => transport.pause(), [transport]);

  const play = async () => {
    try {
      if (transport.duration && transport.time >= transport.duration) transport.seek(0);
      await transport.play(); setPlaying(transport.playing); setError('');
    } catch { setPlaying(false); setError('播放未成功，请重试。'); }
  };
  const syncPlaying = () => setPlaying(transport.playing);

  return <div className="audio-player" role="group" aria-label="原音播放">
    {sources.map((source, index) => <audio key={source.id} ref={element => { audio.current[index] = element; }}
      preload="metadata" src={source.src} aria-label={source.label}
      onLoadedMetadata={() => setError('')}
      onPlay={() => { syncPlaying(); setError(''); }} onPause={syncPlaying} onEnded={syncPlaying}
      onError={() => { transport.pause(); setPlaying(false); setError('原音加载失败，请检查网络与留存状态。'); }}/>) }
    <Button className="player-control" aria-label={playing ? '暂停原音' : '播放原音'} title={playing ? '暂停原音' : '播放原音'}
      onClick={() => { if (playing) { transport.pause(); setPlaying(false); } else void play(); }}>
      {playing ? <Pause size={18} weight="fill" aria-hidden="true"/> : <Play size={18} weight="fill" aria-hidden="true"/>}
    </Button>
    {error && <span className="player-error" role="alert" aria-label={error} title={error}><WarningCircle size={16} aria-hidden="true"/></span>}
  </div>;
}
